/**
 * Fastify preHandler guarding internal-only routes (`/internal/ai/personalize`,
 * `/internal/ai/classify-reply`, `/internal/imap/search`, `/internal/imap/flag`) with a shared
 * callback-secret header, checked with a constant-time comparison.
 *
 * Per the V12 Containerization Model, these routes are additionally reachable ONLY over the
 * package's internal Docker network (`warmhawk_internal`) — nginx never proxies them. This
 * header check is defense in depth on top of that network-level isolation, not a substitute for
 * it: the internal network boundary is what actually keeps these routes unreachable from the
 * public internet; the header stops any OTHER container on that same internal network (n8n,
 * worker) from calling in without knowing the shared secret.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { safeCompare } from './encryption';

const HEADER_NAME = 'x-callback-secret';

export async function requireCallbackSecret(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expected = process.env.NEXTJS_CALLBACK_SECRET;
  if (!expected) {
    reply.code(500).send({ error: 'NEXTJS_CALLBACK_SECRET is not configured on this instance' });
    return reply;
  }
  const provided = request.headers[HEADER_NAME];
  if (typeof provided !== 'string' || !safeCompare(provided, expected)) {
    reply.code(401).send({ error: 'Missing or invalid callback secret' });
    return reply;
  }
}
