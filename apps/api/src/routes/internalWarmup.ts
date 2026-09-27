/**
 * Internal-only trigger for the warmup engine — `POST /internal/warmup/tick`, called every 10
 * minutes by the n8n `warmup-tick` workflow (`n8n/workflows/warmup-tick.json`). Same
 * callback-secret guard as `/internal/seed-placement/poll`; reachable only over the internal
 * Docker network.
 */
import type { FastifyInstance } from 'fastify';
import { requireCallbackSecret } from '../lib/requireCallbackSecret';
import { runWarmupTick } from '../lib/warmup/engine';

export async function internalWarmupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCallbackSecret);

  app.post('/tick', async (_request, reply) => {
    const summary = await runWarmupTick();
    return reply.send(summary);
  });
}
