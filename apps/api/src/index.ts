/**
 * WarmHawk API server bootstrap — graceful shutdown pattern ported forward from outreach-infra's
 * `apps/api/src/index.ts` (SIGINT/SIGTERM -> close server -> exit), adapted to Fastify's
 * `app.close()` (which itself drains in-flight requests before resolving, an improvement over the
 * ported original's bare `server.close()` with no draining).
 */
import 'dotenv/config';
import { startOtel, shutdownOtel } from './otel';
startOtel(); // must run before `./app` (and everything it imports) for auto-instrumentation to patch them
import { createApp } from './app';
import { prisma } from '@warmhawk/db';

const port = Number(process.env.PORT) || 4600;
const host = process.env.HOST || '0.0.0.0';

async function main() {
  const app = await createApp();

  await app.listen({ port, host });
  app.log.info(`[api] listening on ${host}:${port}`);

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`[api] received ${signal}, shutting down`);
    try {
      await app.close();
      await prisma.$disconnect();
      await shutdownOtel();
      process.exit(0);
    } catch (err) {
      app.log.error(err, '[api] error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[api] fatal startup error:', err);
  process.exit(1);
});
