/**
 * Internal-only trigger for the Seed-Inbox Placement Test's polling job — `POST
 * /internal/seed-placement/poll`. Called by the n8n `seed-placement-poll` scheduled workflow
 * (`n8n/workflows/seed-placement-poll.json`), matching the same internal-callback-secret pattern
 * as `/internal/ai/*` and `/imap/*`. Reachable ONLY over the internal Docker network.
 */
import type { FastifyInstance } from 'fastify';
import { requireCallbackSecret } from '../lib/requireCallbackSecret';
import { runSeedPlacementPollTick } from '../lib/seedPlacementPoller';

interface PollBody {
  lookbackHours?: number;
}

export async function internalSeedPlacementRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCallbackSecret);

  app.post<{ Body: PollBody }>('/poll', async (request, reply) => {
    const lookbackHours = request.body?.lookbackHours;
    const summary = await runSeedPlacementPollTick(
      typeof lookbackHours === 'number' && lookbackHours > 0 ? lookbackHours : undefined,
    );
    return reply.send(summary);
  });
}
