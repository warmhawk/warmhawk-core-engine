/**
 * Reconciliation cron — Redis Durability & Crash Recovery (V12), ported concept from jitterflow's
 * `reconcileStuckJobs`. Closes the same class of gap: a Lead row can be marked QUEUED (Postgres
 * write committed) immediately before the corresponding `queue.add()` call, and a crash, deploy
 * restart, or Redis hiccup between those two writes leaves a Lead that Postgres thinks is queued
 * but that no BullMQ job actually represents — a lead that silently never gets emailed, with no
 * error surfaced anywhere (the exact gap the V12 Redis Durability section calls out).
 *
 * Runs on an interval from `apps/worker/src/index.ts` (every few minutes, matching jitterflow's
 * own cadence) — only acts on leads well past their expected send slot, so it never races a
 * legitimately-still-delayed job.
 */
import type { Queue } from 'bullmq';
import { prisma } from '@warmhawk/db';
import { DISPATCH_JOB_NAME } from './queue';

/** Grace period past a lead's recorded `queuedSlotAt` before it's considered stuck rather than
 *  "still legitimately waiting on its jittered delay." */
export const RECONCILE_OVERDUE_GRACE_MINUTES = 15;

/** Re-enqueue delay (seconds) applied to a lead found stuck — short and fixed, since the whole
 *  point is "get this moving again now," not re-run the full jitter/rotation calculation. */
export const RECONCILE_REQUEUE_DELAY_SECONDS = 30;

export interface ReconcileResult {
  checked: number;
  requeued: number;
}

/**
 * Finds Lead rows whose status is QUEUED and whose recorded slot time is overdue by more than
 * `RECONCILE_OVERDUE_GRACE_MINUTES`, checks whether BullMQ still has a job matching the lead's
 * `queuedJobId`, and re-enqueues (with a fresh short delay) any lead for which no such job exists.
 */
export async function reconcileStuckLeads(
  queue: Queue,
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const cutoff = new Date(now.getTime() - RECONCILE_OVERDUE_GRACE_MINUTES * 60 * 1000);

  const candidates = await prisma.lead.findMany({
    where: {
      status: 'QUEUED',
      queuedSlotAt: { lt: cutoff },
      queuedJobId: { not: null },
    },
    take: 500,
  });

  let requeued = 0;

  for (const lead of candidates) {
    if (!lead.queuedJobId) continue; // narrows the type; the where clause already excludes this

    const existingJob = await queue.getJob(lead.queuedJobId);
    if (existingJob) continue; // BullMQ already knows about this job — not actually stuck

    // Recover the mailboxId this lead was assigned to from the job id shape
    // (`${leadId}:${mailboxId}:${slotAtMs}`), constructed by enqueuer.ts.
    const parts = lead.queuedJobId.split(':');
    const mailboxId = parts.length === 3 ? parts[1] : undefined;
    if (!mailboxId) continue; // malformed/legacy job id — skip rather than guess

    const newSlotAtMs = now.getTime() + RECONCILE_REQUEUE_DELAY_SECONDS * 1000;

    // Job id MUST stay in the same `${leadId}:${mailboxId}:${slotAtMs}` (exactly 3 segments)
    // shape enqueuer.ts uses — BullMQ's Job.validateOptions only allows a colon-bearing custom
    // job id through when `jobId.split(':').length === 3` (a legacy compatibility carve-out for
    // repeatable jobs); any other segment count throws `Custom Id cannot contain :`. A previous
    // version of this line appended a 4th `:reconciled` segment purely for log-reading purposes,
    // which meant reconcileStuckLeads() threw on every real re-enqueue attempt — the exact
    // crash-recovery path this function exists for. `newSlotAtMs` already differs from the
    // original slot, so the 3-segment shape carries no less information, and keeping it identical
    // also means this same function can parse its own output back out of `queuedJobId` (see the
    // `parts.length === 3` check above) if a reconciled lead ever gets stuck again.
    const newJobId = `${lead.id}:${mailboxId}:${newSlotAtMs}`;

    await queue.add(
      DISPATCH_JOB_NAME,
      { leadId: lead.id, mailboxId },
      { delay: RECONCILE_REQUEUE_DELAY_SECONDS * 1000, jobId: newJobId },
    );

    await prisma.lead.update({
      where: { id: lead.id },
      data: { queuedJobId: newJobId, queuedSlotAt: new Date(newSlotAtMs) },
    });

    requeued += 1;
  }

  return { checked: candidates.length, requeued };
}
