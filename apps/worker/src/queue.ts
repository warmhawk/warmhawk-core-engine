/**
 * BullMQ queue configuration — ported pattern from outreach-infra's `worker/queue.ts`
 * (queue name/job name constants, Redis connection factory, mailbox reservation key), extended
 * with bounded job retention per the V12 Redis Durability section ("Bounded queue records:
 * completed/failed BullMQ job records capped by age/count, matching jitterflow's
 * `WEBHOOK_QUEUE_JOB_OPTIONS` pattern, so Redis doesn't grow unbounded under `noeviction` on a
 * customer's box with finite disk").
 */
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

export const DISPATCH_QUEUE_NAME = 'warmhawk-dispatch';
export const DISPATCH_JOB_NAME = 'dispatch';
export const DAILY_RESET_JOB_NAME = 'daily-reset';

/** Bounded queue records (V12) — completed jobs are pruned after 24h or 10,000 entries,
 *  failed jobs kept longer (7 days / 10,000) for debugging, matching jitterflow's
 *  `WEBHOOK_QUEUE_JOB_OPTIONS` shape exactly. Postgres (`ExecutionLog`) is the durable record —
 *  Redis/BullMQ job records are disposable bookkeeping, not the source of truth. */
export const DISPATCH_QUEUE_JOB_OPTIONS = {
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
};

export function createRedisConnection(): IORedis {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function createDispatchQueue(connection: IORedis): Queue {
  return new Queue(DISPATCH_QUEUE_NAME, {
    connection,
    defaultJobOptions: DISPATCH_QUEUE_JOB_OPTIONS,
  });
}

export function mailboxReservationKey(mailboxId: string): string {
  return `mailbox:reserved:${mailboxId}`;
}
