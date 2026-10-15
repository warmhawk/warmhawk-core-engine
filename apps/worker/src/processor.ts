/**
 * BullMQ job processor — re-checks eligibility at dispatch time (a mailbox can be paused, capped or
 * lose its domain's mailing address, a campaign can be paused, change its senders or close its
 * send window, and a lead can reply, between enqueue and the job actually firing, given the
 * jittered delay), then hands
 * off the real send to the n8n dispatch workflow over the internal Docker network. The only SMTP
 * this process speaks is the optional pre-send address check (`addressCheck.ts`), which never sends.
 */
import type { Job } from 'bullmq';
import type IORedis from 'ioredis';
import { prisma } from '@warmhawk/db';
import { checkAddress, junkAddressReason } from './addressCheck';
import { currentAddressCheckConfig } from './addressCheckName';
import { cachedVerdict, rememberVerdict, takeUnknownRetry, unknownRetryAt } from './addressRisk';
import { campaignCapToday } from './campaignCap';
import { hasMailingAddress } from './enqueuer';
import { mailboxReservationKey } from './queue';
import { recentSendCount, syncSentToday } from './rollingSends';
import { leadWindowState, SEND_SETTINGS_SELECT } from './sendWindow';

let reservationRedis: IORedis | null = null;

/** Gives the processor the Redis holding each mailbox's booked slot, so a dead address can hand
 *  its slot back, and the saved address checks (`addressRisk.ts`). Set once by the worker
 *  bootstrap; without it the slot just runs out as before and every address is asked fresh. */
export function setReservationRedis(redis: IORedis | null): void {
  reservationRedis = redis;
}

// Deletes the reservation only while it still holds this slot: if the enqueuer has already booked
// the mailbox's next one during the check, that booking stays.
const FREE_SLOT_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

/** Hands a dead address's slot back, so the enqueuer books the mailbox's next lead on its next
 *  tick, timed from the mailbox's last real send rather than from a send that never happened. */
async function freeSlot(mailboxId: string, slotAt: Date | null): Promise<void> {
  if (!reservationRedis || !slotAt) return;
  try {
    await reservationRedis.eval(
      FREE_SLOT_SCRIPT,
      1,
      mailboxReservationKey(mailboxId),
      String(slotAt.getTime()),
    );
  } catch (err) {
    // Harmless: the reservation runs out on its own, a few minutes later.
    console.warn(`[worker] couldn't free mailbox ${mailboxId}'s slot:`, err);
  }
}

/** Puts a first email whose recipient's server said "not now" back in line, to be asked again
 *  at `retryAt`. It keeps its place: the enqueuer re-picks QUEUED leads once `nextRetryAt` passes. */
async function askAgainLater(leadId: string, retryAt: Date): Promise<void> {
  await prisma.lead.updateMany({
    where: { id: leadId, status: 'QUEUED' },
    data: { queuedJobId: null, queuedSlotAt: null, nextRetryAt: retryAt },
  });
}

export interface DispatchJobData {
  leadId: string;
  mailboxId: string;
}

function n8nBaseUrl(): string {
  return process.env.N8N_BASE_URL || 'http://n8n:5678';
}

/** How long a first email waits after a dispatch that failed before `sendMail` could record it
 *  (a compliance refusal, a missing credential). Before this it went straight back to UNTOUCHED and
 *  was re-picked — and re-written by AI — on the very next tick, forever. */
export const DISPATCH_FAILURE_RETRY_MS = 30 * 60 * 1000;
/** The same, for a follow-up: it stays due and tries again after this. */
export const FOLLOW_UP_FAILURE_RETRY_MS = 60 * 60 * 1000;

/** Takes a lead back off the queue without sending. A first email goes back to UNTOUCHED for the
 *  enqueuer to re-assign; a follow-up keeps its due time and loses only its queued job. */
async function releaseLead(leadId: string, followUp: boolean): Promise<void> {
  if (followUp) {
    await prisma.lead.updateMany({
      where: { id: leadId, queuedJobId: { not: null } },
      data: { queuedJobId: null, queuedSlotAt: null },
    });
    return;
  }
  await prisma.lead.updateMany({
    where: { id: leadId, status: 'QUEUED' },
    data: { status: 'UNTOUCHED', queuedJobId: null, queuedSlotAt: null },
  });
}

/** Ends a lead whose address the pre-send check found dead: FAILED, not BOUNCED, since nothing was
 *  sent. The FAILED log row tells the user why without counting toward the bounce rate or the
 *  mailbox's daily sends. */
async function stopDeadAddress(
  leadId: string,
  campaignId: string,
  mailboxId: string,
  detail: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.lead.updateMany({
      where: { id: leadId, status: 'QUEUED' },
      data: { status: 'FAILED', queuedJobId: null, queuedSlotAt: null, nextRetryAt: null },
    }),
    prisma.executionLog.create({
      data: {
        campaignId,
        leadId,
        mailboxId,
        status: 'FAILED',
        errorMessage: `Not sent: ${detail}. Checked before sending, so nothing went out.`,
      },
    }),
  ]);
}

export async function processDispatchJob(data: DispatchJobData): Promise<void> {
  const { leadId, mailboxId } = data;

  const [mailbox, lead] = await Promise.all([
    prisma.mailbox.findUnique({
      where: { id: mailboxId },
      include: { domain: { select: { mailingAddress: true } } },
    }),
    prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        campaign: {
          select: {
            status: true,
            pausedForBounceRate: true,
            ...SEND_SETTINGS_SELECT,
            mailboxes: { where: { mailboxId }, select: { mailboxId: true } },
          },
        },
      },
    }),
  ]);
  if (!lead) return;
  const followUp = lead.stepsSent > 0;

  const now = new Date();
  const mailboxCanSend =
    mailbox &&
    mailbox.status === 'ACTIVE' &&
    hasMailingAddress(mailbox) &&
    (await recentSendCount(mailboxId, now)) <
      campaignCapToday(mailbox.dailyCap, mailbox.warmupGraduatedAt, now);
  // The send window is checked again too: the schedule may have changed since the slot was booked.
  const campaignCanSend =
    lead.campaign.status === 'ACTIVE' &&
    !lead.campaign.pausedForBounceRate &&
    leadWindowState(lead.campaign, lead.customFields, now).open;
  // A first email only from a mailbox the campaign (still) sends from; a follow-up only from the
  // lead's own mailbox, and only while the lead is still waiting on one.
  const leadFits = followUp
    ? lead.mailboxId === mailboxId &&
      (lead.status === 'CONTACTED' || lead.status === 'OPENED') &&
      lead.nextStepAt !== null
    : lead.status === 'QUEUED' && lead.campaign.mailboxes.length > 0;

  if (!mailboxCanSend || !campaignCanSend || !leadFits) {
    // Put the lead back for the enqueuer to re-pick — against a different mailbox for a first
    // email — rather than silently dropping it.
    await releaseLead(leadId, followUp);
    return;
  }

  // A first email only: a follow-up's address already took one. Checked here, before n8n writes
  // the email, so a dead address costs no AI call either.
  if (!followUp) {
    // A placeholder address (name@yoursite.com) is no one's, check or no check.
    const junk = junkAddressReason(lead.email);
    if (junk) {
      await stopDeadAddress(lead.id, lead.campaignId, mailboxId, junk);
      await freeSlot(mailboxId, lead.queuedSlotAt);
      return;
    }
  }
  const addressCheck = await currentAddressCheckConfig();
  if (!followUp && addressCheck) {
    // The look-ahead check (`precheckUpcomingLeads`) usually answered already.
    const saved = reservationRedis ? await cachedVerdict(reservationRedis, lead.id) : null;
    const check = saved ?? (await checkAddress(lead.email, addressCheck));
    if (!saved && reservationRedis) {
      await rememberVerdict(reservationRedis, lead.id, lead.email, check);
    }
    if (check.verdict === 'invalid') {
      await stopDeadAddress(lead.id, lead.campaignId, mailboxId, check.detail);
      await freeSlot(mailboxId, lead.queuedSlotAt);
      return;
    }
    // Greylisting: the server answers "not now" to a sender it hasn't seen. Asked again 30-60
    // minutes later it usually gives a clear answer. After the last try the lead is sent.
    if (
      check.verdict === 'unknown' &&
      check.retryable &&
      reservationRedis &&
      (await takeUnknownRetry(reservationRedis, lead.id))
    ) {
      await askAgainLater(lead.id, unknownRetryAt(now));
      await freeSlot(mailboxId, lead.queuedSlotAt);
      return;
    }
  }

  // The webhook body carries everything n8n's dispatch workflow needs to complete the send
  // without a separate context-fetch round trip: leadId/campaignId (for `/internal/ai/personalize`
  // and the compliance/BCC hooks inside `/internal/mail/send`), mailboxId (the sender), and the
  // recipient's email address (n8n has no direct Postgres access of its own in this repo's design —
  // see n8n/workflows/README.md).
  const response = await fetch(`${n8nBaseUrl()}/webhook/warmhawk/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      leadId,
      mailboxId,
      campaignId: lead.campaignId,
      email: lead.email,
    }),
  });

  // Bug fix (silent lead loss, 2026-09-04): `n8n/workflows/dispatch.json`'s "Respond Failed" node
  // (see that file) always answers with HTTP 200 — n8n's `respondToWebhook` node there is hardcoded
  // to `responseCode: 200` even on a failed send, with `{ status: "failed", error }` as the ONLY
  // signal anything went wrong. This function used to check `response.ok` alone, which is true for
  // that 200-with-failed-body response, so a genuine dispatch failure fell through with no action
  // at all taken here.
  //
  // That silently stranded a real lead in one specific case: `/internal/mail/send`'s own handler
  // (`apps/api/src/lib/mailSender.ts#sendMail`) only records a recoverable outcome (hard bounce ->
  // `BOUNCED`; soft failure -> `QUEUED` with a real `nextRetryAt` backoff and `queuedJobId` cleared)
  // from inside its SMTP try/catch — a failure that never reaches that block (a CAN-SPAM compliance
  // error, a mailbox missing SMTP credentials, or the mailbox/campaign simply not existing, all
  // thrown earlier in `sendMail`) leaves the Lead exactly as the enqueuer last wrote it: `QUEUED`,
  // `nextRetryAt: null`, `queuedJobId` still set to this very job's id. Nothing ever revisits a lead
  // in that state — `enqueuer.ts`'s own query only re-picks up `UNTOUCHED` leads or `QUEUED` leads
  // whose `nextRetryAt` has passed (never true for `null`), and `reconcile.ts`'s stuck-lead cron only
  // acts once BullMQ has actually forgotten the job, which — since this function returned normally,
  // marking the job "completed" — doesn't happen until `queue.ts`'s `removeOnComplete: { age: 24h }`
  // prunes it. The lead would sit invisibly stalled for up to a day, with nothing in the dashboard's
  // queue status or worker logs hinting a send ever failed.
  //
  // Fix: treat a `{status: "failed"}` body the same as a non-2xx response — surface it by throwing
  // (BullMQ marks the job "failed" instead of "completed", which is both visible in the queue
  // status's `failed` count and logged by `worker.on('failed', ...)` in `index.ts`; safe to do
  // unconditionally since this queue's jobs default to a single attempt, so throwing here never
  // triggers an automatic duplicate resend) — and, when `recordSendFailure` never got a chance to
  // reclassify the lead (still `QUEUED` with its original `queuedJobId` intact), revert it to
  // `UNTOUCHED` exactly like the "no longer eligible" branch above, so the enqueuer picks it back up
  // on its very next tick instead of waiting on the 24h-later reconciliation path.
  let responseBody: { status?: string; error?: string } | null = null;
  try {
    responseBody = (await response.json()) as { status?: string; error?: string };
  } catch {
    responseBody = null;
  }

  const dispatchFailed = !response.ok || responseBody?.status !== 'sent';

  if (dispatchFailed) {
    // `queuedJobId` still set means `sendMail` never recorded the failure itself. Wait before
    // the next try rather than re-picking it on the next tick.
    const currentLead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (currentLead?.queuedJobId && followUp) {
      await prisma.lead.updateMany({
        where: { id: leadId, queuedJobId: currentLead.queuedJobId, nextStepAt: { not: null } },
        data: {
          queuedJobId: null,
          queuedSlotAt: null,
          nextStepAt: new Date(Date.now() + FOLLOW_UP_FAILURE_RETRY_MS),
        },
      });
    } else if (currentLead?.queuedJobId && currentLead.status === 'QUEUED') {
      await prisma.lead.updateMany({
        where: { id: leadId, status: 'QUEUED' },
        data: {
          queuedJobId: null,
          queuedSlotAt: null,
          nextRetryAt: new Date(Date.now() + DISPATCH_FAILURE_RETRY_MS),
        },
      });
    }

    const reason = !response.ok
      ? `n8n dispatch webhook responded with ${response.status}`
      : `n8n dispatch webhook reported a failed send: ${responseBody?.error ?? 'unknown error'}`;
    throw new Error(reason);
  }
}

/** The old midnight-UTC reset. The daily limit is a rolling 24 hours now (`rollingSends.ts`), so
 *  this only re-syncs `sentToday` to that count rather than zeroing it. */
export async function processDailyResetJob(): Promise<void> {
  await syncSentToday();
}

/** BullMQ Worker processor function — dispatches to the right handler based on job name. */
export async function processJob(job: Job): Promise<void> {
  if (job.name === 'daily-reset') {
    await processDailyResetJob();
    return;
  }
  await processDispatchJob(job.data as DispatchJobData);
}
