/**
 * Fastify preHandler guarding management routes with a Bearer JWT — ported pattern from
 * outreach-infra's `apps/api/src/middleware/requireAuth.ts`, adapted from Express middleware
 * shape to a Fastify `onRequest`/`preHandler` hook.
 *
 * Auth bridge fix: this JWT scheme authenticates a human against this engine's own Tier 0 `User`
 * table (see `lib/jwt.ts`'s header comment) — the right model for a "no web UI, direct API"
 * customer, but warmhawk-enterprise-operator's dashboard has no such per-human credential here at
 * all (its own login/session/2FA is a separate system, entirely local to that repo). Without this,
 * every one of this engine's `/v1/*` management routes 401s for every dashboard request,
 * permanently. `OPERATOR_SERVICE_TOKEN` is the fix: a single long-lived shared secret (generated
 * once by `scripts/install.sh`, exactly like `NEXTJS_CALLBACK_SECRET` already is for n8n) that the
 * operator dashboard's server-side `coreEngineFetch()` sends as its Bearer token. A match
 * authenticates as a synthetic `ADMIN`-role identity — stateless, no `User` row needed, same
 * "shared secret, not a signed token" pattern this repo already uses for every internal/n8n route.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAuthToken, type AuthUser } from './jwt';
import { safeCompare } from './encryption';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const OPERATOR_SERVICE_USER: AuthUser = {
  sub: 'operator-service',
  email: 'operator-service@internal',
  role: 'ADMIN',
};

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing or malformed Authorization header' });
    return reply;
  }
  const token = header.slice('Bearer '.length).trim();

  const serviceToken = process.env.OPERATOR_SERVICE_TOKEN;
  if (serviceToken && safeCompare(token, serviceToken)) {
    request.user = OPERATOR_SERVICE_USER;
    return;
  }

  try {
    request.user = verifyAuthToken(token);
  } catch {
    reply.code(401).send({ error: 'Invalid or expired token' });
    return reply;
  }
}

export function requireRole(role: AuthUser['role']) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== role && request.user?.role !== 'ADMIN') {
      reply.code(403).send({ error: 'Insufficient role' });
    }
  };
}
