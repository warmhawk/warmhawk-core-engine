/**
 * BullMQ queue configuration — queue name/job name constants, Redis connection factory, mailbox
 * reservation key, extended with bounded job retention per the V12 Redis Durability section
 * ("Bounded queue records: completed/failed BullMQ job records capped by age/count, so Redis
 * doesn't grow unbounded under `noeviction` on a customer's box with finite disk").
 */
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

export const DISPATCH_QUEUE_NAME = 'warmhawk-dispatch';
export const DISPATCH_JOB_NAME = 'dispatch';
export const DAILY_RESET_JOB_NAME = 'daily-reset';

/** Bounded queue records (V12) — completed jobs are pruned after 24h or 10,000 entries,
 *  failed jobs kept longer (7 days / 10,000) for debugging. Postgres (`ExecutionLog`) is the
 *  durable record — Redis/BullMQ job records are disposable bookkeeping, not the source of truth. */
export const DISPATCH_QUEUE_JOB_OPTIONS = {
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
};

/**
 * Builds a `redis://` connection string with the password properly percent-encoded.
 *
 * Bug fix (2026-09-04): `REDIS_PASSWORD` is generated via `openssl rand -base64 32`
 * (`scripts/install.sh`), whose alphabet includes `/` and `+`. Interpolating a password
 * containing `/` directly into `redis://:PASSWORD@host:port` (as `docker-compose.yml`'s plain
 * shell substitution does when building the `REDIS_URL` env var) produces a string that
 * `new URL()` throws `Invalid URL` on — confirmed live: it crash-looped this entire process on
 * every boot attempt. `encodeURIComponent()` here guarantees a syntactically valid URL for ANY
 * password (any character, any generation method, including one a customer sets by hand) — this
 * is not a narrower fix that only helps newly-generated passwords. `ioredis`'s own URL parser
 * (`built/utils/index.js`'s `parseURL`) already calls `decodeURIComponent()` on the parsed
 * username/password, so this round-trips correctly through the exact client that consumes it.
 */
export function buildRedisUrl(host: string, port: number | string, password: string): string {
  return `redis://:${encodeURIComponent(password)}@${host}:${port}`;
}

export function createRedisConnection(): IORedis {
  // Prefer building the URL ourselves from a raw REDIS_PASSWORD so we control the encoding.
  // Falls back to a pre-built REDIS_URL for integration tests / CI / a self-hosted operator
  // pointing this at an external managed Redis (e.g. `rediss://` with its own query-string
  // options) — those callers are expected to hand us an already-valid URL.
  const password = process.env.REDIS_PASSWORD;
  const url = password
    ? buildRedisUrl(process.env.REDIS_HOST || 'redis', process.env.REDIS_PORT || 6379, password)
    : process.env.REDIS_URL || 'redis://localhost:6379';
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
