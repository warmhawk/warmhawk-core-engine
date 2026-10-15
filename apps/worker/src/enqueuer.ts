/**
 * Weighted mailbox rotation + lead scheduling — addresses Competitor Pain Points #13:
 * "Woodpecker: rotation across mailboxes is sequential, not weighted" by doing
 * least-recently-used, capacity-aware rotation instead. Extended for the V12 Redis Durability
 * section: every enqueue now also persists `queuedJobId`/`queuedSlotAt` onto the Lead row so
 * `reconcile.ts`'s `reconcileStuckLeads()` can detect a write-then-crash gap (DB says "should be
 * queued", no matching BullMQ job exists) and safely re-enqueue.
 *
 * The mailbox-selection logic itself is factored into a pure, dependency-free function
 * (`selectNextMailbox`) so the weighted-rotation behavior is unit-testable without a real
 * Postgres/Redis/BullMQ instance — the full `runEnqueuerTick` (I/O-bound) is covered separately
 * by the integration test suite against a real Postgres + Redis (`docker-compose.test.yml`).
 */
import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { DAY_MS, prisma, type WindowState } from '@warmhawk/db';
import { lastRiskyMailboxes, markLastBooking, riskyLeadIds } from './addressRisk';
import { computeNextSlotSeconds } from './computeNextSlotSeconds';
import { campaignCapToday } from './campaignCap';
import { syncCampaignCompletion } from './campaignCompletion';
import { DISPATCH_JOB_NAME, mailboxReservationKey } from './queue';
import { deferredMailboxes, recentSendTimes } from './rollingSends';
import { leadWindowState, SEND_SETTINGS_SELECT, type CampaignSendSettings } from './sendWindow';

/** Leads read per pass. More than the mailboxes can take in one tick, so leads whose window is
 *  closed (another time zone, a day off) don't hide ones that can go now. */
const LEAD_SCAN_SIZE = 200;
const RESERVATION_TTL_PADDING_SECONDS = 120;

export interface MailboxCandidate {
  id: string;
  lastSentAt: Date | null;
  sentToday: number;
  dailyCap: number;
  /** Least-recently-used sort key, in ms since epoch (or -Infinity for "never sent"). Advanced
   *  in-memory after each assignment within a single tick so later leads in the same batch don't
   *  pile onto the same mailbox before the DB/Redis state is actually written. */
  sortKeyMs: number;
}

export interface MailboxSelectionResult {
  /** The chosen mailbox candidate, or null if every candidate is at/over its daily cap. */
  chosen: MailboxCandidate | null;
  /** The candidate list with the chosen mailbox's in-memory state advanced (and removed if it
   *  just hit its cap) — feed this back in as `candidates` for the next lead in the same tick. */
  remaining: MailboxCandidate[];
}

/**
 * Pure weighted-rotation selection: sorts candidates by least-recently-used (`sortKeyMs`
 * ascending), picks the first, advances its in-memory state to the newly-assigned slot time, and
 * decrements its remaining daily capacity — removing it from the pool entirely once it hits its
 * cap. No I/O; the caller is responsible for persisting the outcome.
 */
export function selectNextMailbox(
  candidates: MailboxCandidate[],
  assignedSlotMs: number,
): MailboxSelectionResult {
  if (candidates.length === 0) {
    return { chosen: null, remaining: candidates };
  }

  const sorted = [...candidates].sort((a, b) => a.sortKeyMs - b.sortKeyMs);
  const chosen = sorted[0];
  const rest = sorted.slice(1);

  const advanced: MailboxCandidate = {
    ...chosen,
    sortKeyMs: assignedSlotMs,
    sentToday: chosen.sentToday + 1,
  };

  const remaining =
    advanced.sentToday >= advanced.dailyCap
      ? rest
      : [...rest, advanced].sort((a, b) => a.sortKeyMs - b.sortKeyMs);

  return { chosen: advanced, remaining };
}

/** What a campaign send needs from a mailbox beyond being ACTIVE: its domain has a mailing address
 *  for the CAN-SPAM footer. A mailbox without one is never handed a lead — the send would be refused. */
export const SENDABLE_MAILBOX_WHERE = {
  status: 'ACTIVE' as const,
  domain: { mailingAddress: { not: null } },
};

export function hasMailingAddress(mailbox: { domain: { mailingAddress: string | null } }): boolean {
  return Boolean(mailbox.domain.mailingAddress?.trim());
}

/**
 * The gap that spreads a mailbox's remaining sends evenly over the rest of a send window: time
 * left divided by sends left. Sends older than (window end − 24h) stop counting against the
 * rolling limit before the window closes, so they don't use up room. 0 with no schedule.
 */
export function spreadGapMs(
  window: WindowState,
  dailyCap: number,
  sendTimesMs: number[],
  nowMs: number,
): number {
  if (!Number.isFinite(window.msLeft) || window.msLeft <= 0) return 0;
  const windowEndMs = nowMs + window.msLeft;
  const stillCounted = sendTimesMs.filter((t) => t > windowEndMs - DAY_MS).length;
  return window.msLeft / Math.max(1, dailyCap - stillCounted);
}

interface PoolEntry extends MailboxCandidate {
  /** This mailbox's send times in the last 24 hours, for the spread. */
  sendTimesMs: number[];
  /** Its last booked slot, when that slot has already come round. */
  pendingAt: Date | null;
  /** 2 when its provider deferred a send in the last day: twice the gap between sends. */
  paceFactor: number;
}

/**
 * Runs one enqueuer tick, in two passes that share the mailboxes' daily capacity:
 *
 *   1. Follow-ups that are due (`Lead.nextStepAt` passed), each from the mailbox that sent the
 *      lead's first email — never another one, so the lead sees one sender in one thread. They go
 *      first: a sequence someone started should finish on time.
 *   2. First emails, each rotated (least-recently-used) across only the mailboxes that campaign
 *      sends from (`CampaignMailbox`) — never every mailbox on the install — and no more than the
 *      campaign's `maxNewLeadsPerDay` in any 24 hours.
 *
 * Only ACTIVE mailboxes under their limit whose domain has a mailing address are used. The limit
 * is counted over a rolling 24 hours (`rollingSends.ts`). Send schedule (10-14-26):
 *
 *   - A lead is only queued while its campaign's send window is open — in the lead's own time
 *     zone when the campaign asks for that — and only into a slot before the window closes. A
 *     follow-up due outside the window waits for the next one.
 *   - Each mailbox holds at most one booked slot at a time. Before this, every tick re-booked the
 *     mailbox's whole remaining limit (`sentToday` only moves on a real send), stacking up
 *     hundreds of queued leads hours ahead.
 *   - The slot is spaced to spread the mailbox's remaining limit over what's left of the window
 *     (`spreadGapMs`), never closer than the 8-minute floor.
 *
 * Mailbox protection (10-15-26):
 *
 *   - A mailbox whose provider deferred or rate-limited a send in the last 24 hours runs at half
 *     pace: half its daily limit, twice the gap between sends.
 *   - A risky first email (catch-all server, Yahoo/AOL, no clear check answer — `addressRisk.ts`)
 *     doesn't follow another risky one on the same mailbox while a confirmed address in its
 *     campaign can go now. It takes that mailbox's next slot instead; every lead is still sent.
 *
 * Each slot is reserved in Redis, the BullMQ dispatch job is scheduled with the computed delay,
 * and `queuedJobId`/`queuedSlotAt` are persisted on the Lead row for crash recovery. A first email
 * moves the lead to QUEUED; a follow-up leaves its status alone (it stays CONTACTED/OPENED) and is
 * marked queued by `queuedJobId` alone.
 *
 * Before either pass, `syncCampaignCompletion` marks campaigns with nothing left to send Completed
 * and puts Completed ones with new work back to Sending, so that work is picked up this tick.
 */
export async function runEnqueuerTick(
  queue: Queue,
  redis: IORedis,
  now: Date = new Date(),
): Promise<number> {
  await syncCampaignCompletion();

  const campaigns = await prisma.campaign.findMany({
    where: { status: 'ACTIVE', pausedForBounceRate: false },
    select: { id: true, maxNewLeadsPerDay: true, ...SEND_SETTINGS_SELECT },
  });
  if (campaigns.length === 0) return 0;
  const campaignById = new Map<string, CampaignSendSettings>(campaigns.map((c) => [c.id, c]));
  const windowFor = (campaignId: string, customFields: unknown): WindowState | null => {
    const campaign = campaignById.get(campaignId);
    return campaign ? leadWindowState(campaign, customFields, now) : null;
  };
  // Campaigns that may have a lead to send now: an open window, or a window per lead.
  const sendableCampaignIds = campaigns
    .filter((c) => c.useLeadTimezone || windowFor(c.id, null)?.open)
    .map((c) => c.id);
  if (sendableCampaignIds.length === 0) return 0;

  const mailboxes = await prisma.mailbox.findMany({
    where: SENDABLE_MAILBOX_WHERE,
    orderBy: [{ lastSentAt: { sort: 'asc', nulls: 'first' } }],
    include: { domain: { select: { mailingAddress: true } } },
  });
  const sendTimes = await recentSendTimes(
    mailboxes.map((m) => m.id),
    now,
  );
  const reservations = mailboxes.length
    ? await redis.mget(...mailboxes.map((m) => mailboxReservationKey(m.id)))
    : [];
  const deferred = await deferredMailboxes(
    mailboxes.map((m) => m.id),
    now,
  );

  const pool = new Map<string, PoolEntry>();
  mailboxes.forEach((m, i) => {
    if (!hasMailingAddress(m)) return;
    const fullCap = campaignCapToday(m.dailyCap, m.warmupGraduatedAt, now);
    const slowed = deferred.has(m.id);
    const cap = slowed ? Math.max(1, Math.floor(fullCap / 2)) : fullCap;
    const sendTimesMs = sendTimes.get(m.id) ?? [];
    if (sendTimesMs.length >= cap) return;
    const pendingAt = reservations[i] ? new Date(Number(reservations[i])) : null;
    // One booked slot at a time: a mailbox whose slot hasn't come round yet waits for it.
    if (pendingAt && pendingAt.getTime() > now.getTime()) return;
    pool.set(m.id, {
      id: m.id,
      lastSentAt: m.lastSentAt,
      sentToday: sendTimesMs.length,
      dailyCap: cap,
      sortKeyMs: m.lastSentAt ? m.lastSentAt.getTime() : -Infinity,
      sendTimesMs,
      pendingAt,
      paceFactor: slowed ? 2 : 1,
    });
  });
  if (pool.size === 0) return 0;

  /** Books the next slot on `target` for a lead in `window`, or returns null when the slot would
   *  land after the window closes. A booked mailbox leaves the pool for this tick. */
  const takeSlot = async (target: PoolEntry, leadId: string, window: WindowState) => {
    const spreadMs = spreadGapMs(window, target.dailyCap, target.sendTimesMs, now.getTime());
    const delaySeconds = computeNextSlotSeconds(
      target.lastSentAt,
      now,
      target.pendingAt,
      spreadMs,
      target.paceFactor,
    );
    if (delaySeconds * 1000 >= window.msLeft) return null;
    const slotAtMs = now.getTime() + delaySeconds * 1000;
    pool.delete(target.id);
    await redis.set(
      mailboxReservationKey(target.id),
      String(slotAtMs),
      'EX',
      delaySeconds + RESERVATION_TTL_PADDING_SECONDS,
    );
    return { delaySeconds, slotAtMs, jobId: `${leadId}:${target.id}:${slotAtMs}` };
  };

  let enqueued = 0;

  // Pass 1 — due follow-ups, from each lead's own mailbox.
  const dueFollowUps = await prisma.lead.findMany({
    where: {
      status: { in: ['CONTACTED', 'OPENED'] },
      nextStepAt: { lte: now },
      queuedJobId: null,
      mailboxId: { in: [...pool.keys()] },
      // A reply recorded before replies set REPLIED still ends the sequence.
      replies: { none: {} },
      campaignId: { in: sendableCampaignIds },
    },
    orderBy: { nextStepAt: 'asc' },
    take: LEAD_SCAN_SIZE,
  });
  for (const lead of dueFollowUps) {
    if (pool.size === 0) return enqueued;
    const target = lead.mailboxId ? pool.get(lead.mailboxId) : undefined;
    if (!target) continue; // its mailbox already took a lead this tick, or is at its limit
    const window = windowFor(lead.campaignId, lead.customFields);
    if (!window?.open) continue; // waits for the next window
    const slot = await takeSlot(target, lead.id, window);
    if (!slot) continue;
    await prisma.lead.update({
      where: { id: lead.id },
      data: { queuedJobId: slot.jobId, queuedSlotAt: new Date(slot.slotAtMs) },
    });
    await queue.add(
      DISPATCH_JOB_NAME,
      { leadId: lead.id, mailboxId: target.id },
      { delay: slot.delaySeconds * 1000, jobId: slot.jobId },
    );
    enqueued += 1;
  }
  if (pool.size === 0) return enqueued;

  // First emails left today per campaign with a "max new leads per day": its first sends in the
  // last 24 hours and the ones already booked count against it. A follow-up waits at least a day
  // (`MIN_WAIT_DAYS`), so a lead on its first email within 24 hours still has `stepsSent` 1.
  const newLeadsLeft = new Map<string, number>();
  const capped = campaigns.filter((c) => c.maxNewLeadsPerDay != null);
  if (capped.length > 0) {
    const used = await prisma.lead.groupBy({
      by: ['campaignId'],
      where: {
        campaignId: { in: capped.map((c) => c.id) },
        OR: [
          { stepsSent: 1, lastStepAt: { gt: new Date(now.getTime() - DAY_MS) } },
          { status: 'QUEUED', queuedJobId: { not: null } },
        ],
      },
      _count: { _all: true },
    });
    for (const c of capped) {
      const count = used.find((row) => row.campaignId === c.id)?._count._all ?? 0;
      newLeadsLeft.set(c.id, Math.max(0, (c.maxNewLeadsPerDay as number) - count));
    }
  }
  const firstEmailCampaignIds = sendableCampaignIds.filter((id) => newLeadsLeft.get(id) !== 0);
  if (firstEmailCampaignIds.length === 0) return enqueued;

  // Pass 2 — first emails, each from one of its campaign's own mailboxes.
  const leads = await prisma.lead.findMany({
    where: {
      // `pausedForBounceRate: false` (in `sendableCampaignIds`) — Guardrails circuit breaker (see
      // `lib/mailSender.ts`'s `applyBounceCircuitBreaker`): a campaign whose rolling bounce rate
      // tripped its threshold stops being picked up here even while `status` itself stays ACTIVE,
      // since the two fields track independent things (is this campaign scheduled to run vs. did
      // reputation protection step in) and a customer resuming from a manual pause shouldn't need
      // to separately clear a stale bounce flag that was never set.
      campaignId: { in: firstEmailCampaignIds },
      campaign: { mailboxes: { some: { mailboxId: { in: [...pool.keys()] } } } },
      OR: [{ status: 'UNTOUCHED' }, { status: 'QUEUED', nextRetryAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: LEAD_SCAN_SIZE,
  });
  if (leads.length === 0) return enqueued;

  const links = await prisma.campaignMailbox.findMany({
    where: { campaignId: { in: [...new Set(leads.map((l) => l.campaignId))] } },
    select: { campaignId: true, mailboxId: true },
  });
  const sendersByCampaign = new Map<string, string[]>();
  for (const link of links) {
    sendersByCampaign.set(link.campaignId, [
      ...(sendersByCampaign.get(link.campaignId) ?? []),
      link.mailboxId,
    ]);
  }

  // Which leads are risky, which mailboxes just had one, and how many confirmed leads per campaign
  // could go now. Without Redis answers every lead counts as confirmed, as before.
  const risky = await riskyLeadIds(redis, leads).catch(() => new Set<string>());
  const lastRisky = await lastRiskyMailboxes(redis, [...pool.keys()]).catch(
    () => new Set<string>(),
  );
  const confirmedReady = new Map<string, number>();
  for (const lead of leads) {
    if (risky.has(lead.id) || !windowFor(lead.campaignId, lead.customFields)?.open) continue;
    confirmedReady.set(lead.campaignId, (confirmedReady.get(lead.campaignId) ?? 0) + 1);
  }

  for (const lead of leads) {
    if (pool.size === 0) break;
    const left = newLeadsLeft.get(lead.campaignId);
    if (left === 0) continue;
    const window = windowFor(lead.campaignId, lead.customFields);
    if (!window?.open) continue;
    let candidates = (sendersByCampaign.get(lead.campaignId) ?? [])
      .map((id) => pool.get(id))
      .filter((c): c is PoolEntry => Boolean(c));
    const isRisky = risky.has(lead.id);
    if (isRisky) {
      // A mailbox whose last first email was risky takes a confirmed lead next, if there is one.
      const rested = candidates.filter((c) => !lastRisky.has(c.id));
      if (rested.length > 0) candidates = rested;
      else if ((confirmedReady.get(lead.campaignId) ?? 0) > 0) continue;
    }
    // Least-recently-used of this campaign's mailboxes that still have room today.
    const target = [...candidates].sort((a, b) => a.sortKeyMs - b.sortKeyMs)[0];
    if (!target) continue;

    const slot = await takeSlot(target, lead.id, window);
    if (!slot) continue;
    if (left !== undefined) newLeadsLeft.set(lead.campaignId, left - 1);
    if (isRisky) {
      lastRisky.add(target.id);
    } else {
      lastRisky.delete(target.id);
      confirmedReady.set(lead.campaignId, (confirmedReady.get(lead.campaignId) ?? 1) - 1);
    }
    await markLastBooking(redis, target.id, isRisky).catch(() => undefined);

    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        status: 'QUEUED',
        nextRetryAt: null,
        queuedJobId: slot.jobId,
        queuedSlotAt: new Date(slot.slotAtMs),
      },
    });

    await queue.add(
      DISPATCH_JOB_NAME,
      { leadId: lead.id, mailboxId: target.id },
      { delay: slot.delaySeconds * 1000, jobId: slot.jobId },
    );

    enqueued += 1;
  }

  return enqueued;
}
