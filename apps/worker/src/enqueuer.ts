/**
 * Weighted mailbox rotation + lead scheduling — ported forward from outreach-infra's
 * `apps/api/src/worker/enqueuer.ts` (verified already built — Competitor Pain Points #13:
 * "Woodpecker: rotation across mailboxes is sequential, not weighted" / "enqueuer.ts does
 * least-recently-used, capacity-aware rotation"), extended for the V12 Redis Durability section:
 * every enqueue now also persists `queuedJobId`/`queuedSlotAt` onto the Lead row so
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

/**
 * Runs one enqueuer tick: pulls up to `LEAD_BATCH_SIZE` eligible leads, rotates them across
 * capacity-available ACTIVE mailboxes using `selectNextMailbox`, reserves each assigned slot in
 * Redis (collision avoidance within the tick), schedules the BullMQ dispatch job with the
 * computed delay, and persists `queuedJobId`/`queuedSlotAt` on the Lead row for crash recovery.
 */
export async function runEnqueuerTick(
  queue: Queue,
  redis: IORedis,
  now: Date = new Date(),
): Promise<number> {
  const leads = await prisma.lead.findMany({
    where: {
      // `pausedForBounceRate: false` — Guardrails circuit breaker (see `lib/mailSender.ts`'s
      // `applyBounceCircuitBreaker`): a campaign whose rolling bounce rate tripped its threshold
      // stops being picked up here even while `status` itself stays ACTIVE, since the two fields
      // track independent things (is this campaign scheduled to run vs. did reputation protection
      // step in) and a customer resuming from a manual pause shouldn't need to separately clear a
      // stale bounce flag that was never set.
      campaign: { status: 'ACTIVE', pausedForBounceRate: false },
      OR: [{ status: 'UNTOUCHED' }, { status: 'QUEUED', nextRetryAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: LEAD_BATCH_SIZE,
  });
  if (leads.length === 0) return 0;

  const mailboxes = await prisma.mailbox.findMany({
    where: { status: 'ACTIVE' },
    orderBy: [{ lastSentAt: { sort: 'asc', nulls: 'first' } }],
  });

  let candidates: MailboxCandidate[] = mailboxes
    .filter((m) => m.sentToday < m.dailyCap)
    .map((m) => ({
      id: m.id,
      lastSentAt: m.lastSentAt,
      sentToday: m.sentToday,
      dailyCap: m.dailyCap,
      sortKeyMs: m.lastSentAt ? m.lastSentAt.getTime() : -Infinity,
    }));

  let enqueued = 0;

  for (const lead of leads) {
    if (candidates.length === 0) break;

    // Peek at the current LRU-first candidate to compute its jittered delay before committing
    // the in-memory rotation state via selectNextMailbox.
    const lruSorted = [...candidates].sort((a, b) => a.sortKeyMs - b.sortKeyMs);
    const target = lruSorted[0];

    const reservationKey = mailboxReservationKey(target.id);
    const existingReservation = await redis.get(reservationKey);
    const pendingReservationAt = existingReservation ? new Date(Number(existingReservation)) : null;

    const delaySeconds = computeNextSlotSeconds(target.lastSentAt, now, pendingReservationAt);
    const slotAtMs = now.getTime() + delaySeconds * 1000;

    const { chosen, remaining } = selectNextMailbox(candidates, slotAtMs);
    if (!chosen) break;
    candidates = remaining;

    await redis.set(
      reservationKey,
      String(slotAtMs),
      'EX',
      delaySeconds + RESERVATION_TTL_PADDING_SECONDS,
    );

    const jobId = `${lead.id}:${chosen.id}:${slotAtMs}`;

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
      { leadId: lead.id, mailboxId: chosen.id },
      { delay: delaySeconds * 1000, jobId },
    );

    enqueued += 1;
  }

  return enqueued;
}
