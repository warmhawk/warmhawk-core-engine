/**
 * Internal-only trigger for the Seed-Inbox Placement Test's polling job — `POST
 * /internal/seed-placement/poll`. Called by the n8n `seed-placement-poll` scheduled workflow
 * (`n8n/workflows/seed-placement-poll.json`), matching the same internal-callback-secret pattern
 * as `/internal/ai/*` and `/imap/*`. Reachable ONLY over the internal Docker network.
 */
import type { FastifyInstance } from 'fastify';
import { requireCallbackSecret } from '../lib/requireCallbackSecret';
import { runSeedPlacementPollTick } from '../lib/seedPlacementPoller';

export async function internalSeedPlacementRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCallbackSecret);

  // Older workflows still post `{ lookbackHours }`; the check now works from pending samples,
  // so the body is ignored.
  app.post('/poll', async (_request, reply) => {
    const summary = await runSeedPlacementPollTick();
    return reply.send(summary);
  });
}
