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
import { prisma } from '@warmhawk/db';
import { computeNextSlotSeconds } from './computeNextSlotSeconds';
import { campaignCapToday } from './campaignCap';
import { DISPATCH_JOB_NAME, mailboxReservationKey } from './queue';

const LEAD_BATCH_SIZE = 20;
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
 * Runs one enqueuer tick, in two passes that share the mailboxes' daily capacity:
 *
 *   1. Follow-ups that are due (`Lead.nextStepAt` passed), each from the mailbox that sent the
 *      lead's first email — never another one, so the lead sees one sender in one thread. They go
 *      first: a sequence someone started should finish on time.
 *   2. First emails, each rotated (least-recently-used) across only the mailboxes that campaign
 *      sends from (`CampaignMailbox`) — never every mailbox on the install.
 *
 * Only ACTIVE mailboxes under today's cap whose domain has a mailing address are used. Each
 * assigned slot is reserved in Redis (collision avoidance within the tick), the BullMQ dispatch job
 * is scheduled with the computed delay, and `queuedJobId`/`queuedSlotAt` are persisted on the Lead
 * row for crash recovery. A first email moves the lead to QUEUED; a follow-up leaves its status
 * alone (it stays CONTACTED/OPENED) and is marked queued by `queuedJobId` alone.
 */
export async function runEnqueuerTick(
  queue: Queue,
  redis: IORedis,
  now: Date = new Date(),
): Promise<number> {
  const mailboxes = await prisma.mailbox.findMany({
    where: SENDABLE_MAILBOX_WHERE,
    orderBy: [{ lastSentAt: { sort: 'asc', nulls: 'first' } }],
    include: { domain: { select: { mailingAddress: true } } },
  });

  const pool = new Map<string, MailboxCandidate>();
  for (const m of mailboxes) {
    if (!hasMailingAddress(m)) continue;
    const cap = campaignCapToday(m.dailyCap, m.warmupGraduatedAt, now);
    if (m.sentToday >= cap) continue;
    pool.set(m.id, {
      id: m.id,
      lastSentAt: m.lastSentAt,
      sentToday: m.sentToday,
      dailyCap: cap,
      sortKeyMs: m.lastSentAt ? m.lastSentAt.getTime() : -Infinity,
    });
  }
  if (pool.size === 0) return 0;

  /** Reserves the next slot on `target`, advances its in-memory rotation state (dropping it from
   *  the pool at its cap), and returns the job's delay and id. */
  const takeSlot = async (target: MailboxCandidate, leadId: string) => {
    const reservationKey = mailboxReservationKey(target.id);
    const existingReservation = await redis.get(reservationKey);
    const pendingReservationAt = existingReservation ? new Date(Number(existingReservation)) : null;

    const delaySeconds = computeNextSlotSeconds(target.lastSentAt, now, pendingReservationAt);
    const slotAtMs = now.getTime() + delaySeconds * 1000;

    const { chosen } = selectNextMailbox([target], slotAtMs);
    if (chosen && chosen.sentToday < chosen.dailyCap) pool.set(target.id, chosen);
    else pool.delete(target.id);

    await redis.set(
      reservationKey,
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
      campaign: { status: 'ACTIVE', pausedForBounceRate: false },
    },
    orderBy: { nextStepAt: 'asc' },
    take: LEAD_BATCH_SIZE,
  });
  for (const lead of dueFollowUps) {
    const target = lead.mailboxId ? pool.get(lead.mailboxId) : undefined;
    if (!target) continue; // its mailbox hit today's cap earlier in this pass; tomorrow
    const { delaySeconds, slotAtMs, jobId } = await takeSlot(target, lead.id);
    await prisma.lead.update({
      where: { id: lead.id },
      data: { queuedJobId: jobId, queuedSlotAt: new Date(slotAtMs) },
    });
    await queue.add(
      DISPATCH_JOB_NAME,
      { leadId: lead.id, mailboxId: target.id },
      { delay: delaySeconds * 1000, jobId },
    );
    enqueued += 1;
  }
  if (pool.size === 0) return enqueued;

  // Pass 2 — first emails, each from one of its campaign's own mailboxes.
  const leads = await prisma.lead.findMany({
    where: {
      // `pausedForBounceRate: false` — Guardrails circuit breaker (see `lib/mailSender.ts`'s
      // `applyBounceCircuitBreaker`): a campaign whose rolling bounce rate tripped its threshold
      // stops being picked up here even while `status` itself stays ACTIVE, since the two fields
      // track independent things (is this campaign scheduled to run vs. did reputation protection
      // step in) and a customer resuming from a manual pause shouldn't need to separately clear a
      // stale bounce flag that was never set.
      campaign: {
        status: 'ACTIVE',
        pausedForBounceRate: false,
        mailboxes: { some: { mailboxId: { in: [...pool.keys()] } } },
      },
      OR: [{ status: 'UNTOUCHED' }, { status: 'QUEUED', nextRetryAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: LEAD_BATCH_SIZE,
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

  for (const lead of leads) {
    if (pool.size === 0) break;
    const candidates = (sendersByCampaign.get(lead.campaignId) ?? [])
      .map((id) => pool.get(id))
      .filter((c): c is MailboxCandidate => Boolean(c));
    // Least-recently-used of this campaign's mailboxes that still have room today.
    const target = [...candidates].sort((a, b) => a.sortKeyMs - b.sortKeyMs)[0];
    if (!target) continue;

    const { delaySeconds, slotAtMs, jobId } = await takeSlot(target, lead.id);

    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        status: 'QUEUED',
        nextRetryAt: null,
        queuedJobId: jobId,
        queuedSlotAt: new Date(slotAtMs),
      },
    });

    await queue.add(
      DISPATCH_JOB_NAME,
      { leadId: lead.id, mailboxId: target.id },
      { delay: delaySeconds * 1000, jobId },
    );

    enqueued += 1;
  }

  return enqueued;
}
