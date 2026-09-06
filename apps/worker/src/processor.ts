/**
 * BullMQ job processor — re-checks mailbox eligibility at dispatch time (a mailbox can be
 * paused/capped between enqueue and the job actually firing, given the jittered delay), then hands
 * off the real send to the n8n dispatch workflow over the internal Docker network — this process
 * never talks to an SMTP server directly.
 */
import type { Job } from 'bullmq';
import { prisma } from '@warmhawk/db';

export interface DispatchJobData {
  leadId: string;
  mailboxId: string;
}

function n8nBaseUrl(): string {
  return process.env.N8N_BASE_URL || 'http://n8n:5678';
}

export async function processDispatchJob(data: DispatchJobData): Promise<void> {
  const { leadId, mailboxId } = data;

  const [mailbox, lead] = await Promise.all([
    prisma.mailbox.findUnique({ where: { id: mailboxId } }),
    prisma.lead.findUnique({ where: { id: leadId } }),
  ]);
  const stillEligible =
    mailbox && lead && mailbox.status === 'ACTIVE' && mailbox.sentToday < mailbox.dailyCap;

  if (!stillEligible) {
    // Revert the lead to UNTOUCHED so the enqueuer re-picks it up against a different mailbox on
    // its next tick, rather than silently dropping it.
    await prisma.lead.updateMany({
      where: { id: leadId, status: 'QUEUED' },
      data: { status: 'UNTOUCHED', queuedJobId: null, queuedSlotAt: null },
    });
    return;
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
    const currentLead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (currentLead && currentLead.status === 'QUEUED' && currentLead.queuedJobId) {
      await prisma.lead.updateMany({
        where: { id: leadId, status: 'QUEUED' },
        data: { status: 'UNTOUCHED', queuedJobId: null, queuedSlotAt: null },
      });
    }

    const reason = !response.ok
      ? `n8n dispatch webhook responded with ${response.status}`
      : `n8n dispatch webhook reported a failed send: ${responseBody?.error ?? 'unknown error'}`;
    throw new Error(reason);
  }
}

export async function processDailyResetJob(): Promise<void> {
  await prisma.mailbox.updateMany({ data: { sentToday: 0 } });
}

/** BullMQ Worker processor function — dispatches to the right handler based on job name. */
export async function processJob(job: Job): Promise<void> {
  if (job.name === 'daily-reset') {
    await processDailyResetJob();
    return;
  }
  await processDispatchJob(job.data as DispatchJobData);
}
