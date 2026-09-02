/**
 * WarmHawk worker bootstrap — graceful shutdown pattern (SIGINT/SIGTERM -> close worker, queue,
 * redis connection, disconnect Prisma, then exit), extended per V12 with:
 *   - the reconciliation cron (`reconcileStuckLeads`, every few minutes)
 *   - a slightly longer grace-period shutdown so an in-flight job actually finishes rather than
 *     being cut off mid-dispatch (a 30s stop_grace_period).
 */
import 'dotenv/config';
import { startOtel, shutdownOtel } from './otel';
startOtel(); // must run before bullmq/ioredis are imported below, for auto-instrumentation to patch them
import { Worker } from 'bullmq';
import { prisma } from '@warmhawk/db';
import { runEnqueuerTick } from './enqueuer';
import { reconcileStuckLeads } from './reconcile';
import { processJob } from './processor';
import {
  createDispatchQueue,
  createRedisConnection,
  DAILY_RESET_JOB_NAME,
  DISPATCH_QUEUE_NAME,
} from './queue';

const ENQUEUER_INTERVAL_MS = 30_000;
const RECONCILE_INTERVAL_MS = 5 * 60_000; // every 5 minutes, per the V12 Redis Durability section

async function main() {
  const connection = createRedisConnection();
  const queue = createDispatchQueue(connection);

  const worker = new Worker(DISPATCH_QUEUE_NAME, processJob, { connection });
  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} (${job?.name}) failed:`, err);
  });

  await queue.add(
    DAILY_RESET_JOB_NAME,
    {},
    { repeat: { pattern: '0 0 * * *' }, jobId: 'daily-reset' },
  );

  const enqueuerInterval = setInterval(() => {
    runEnqueuerTick(queue, connection).catch((err) => {
      console.error('[worker] enqueuer tick failed:', err);
    });
  }, ENQUEUER_INTERVAL_MS);

  const reconcileInterval = setInterval(() => {
    reconcileStuckLeads(queue)
      .then((result) => {
        if (result.requeued > 0) {
          console.warn(
            `[worker] reconciliation: checked ${result.checked} overdue lead(s), re-enqueued ${result.requeued}.`,
          );
        }
      })
      .catch((err) => {
        console.error('[worker] reconciliation tick failed:', err);
      });
  }, RECONCILE_INTERVAL_MS);

  // Run one of each immediately on boot rather than waiting a full interval.
  runEnqueuerTick(queue, connection).catch((err) => {
    console.error('[worker] initial enqueuer tick failed:', err);
  });
  reconcileStuckLeads(queue).catch((err) => {
    console.error('[worker] initial reconciliation tick failed:', err);
  });

  console.log('[worker] WarmHawk dispatch worker started');

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, shutting down`);
    clearInterval(enqueuerInterval);
    clearInterval(reconcileInterval);
    // Give any in-flight job a grace window to finish rather than cutting it off mid-dispatch
    // (a 30s stop_grace_period; enforced by the compose file's own stop_grace_period, this is
    // just the process-level half of that contract).
    await worker.close();
    await queue.close();
    await connection.quit();
    await prisma.$disconnect();
    await shutdownOtel();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] fatal startup error:', err);
  process.exit(1);
});
