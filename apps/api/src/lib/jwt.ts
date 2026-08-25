/**
 * JWT auth token sign/verify — ported pattern from outreach-infra's `apps/api/src/lib/jwt.ts`.
 * Protects warmhawk-core-engine's own management routes (domains, campaigns, leads admin
 * actions) — a Tier 0 ("direct API endpoints, no web UI") customer authenticates directly
 * against this API, distinct from warmhawk-enterprise-operator's separate dashboard
 * session/login model.
 */
import jwt from 'jsonwebtoken';

export interface AuthUser {
  sub: string;
  email: string;
  role: 'ADMIN' | 'OPERATOR';
}

const DEFAULT_TTL_SECONDS = 8 * 60 * 60; // 8 hours

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set. Generate one with: openssl rand -base64 48');
  }
  return secret;
}

export function signAuthToken(payload: AuthUser, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  return jwt.sign(payload, getSecret(), { algorithm: 'HS256', expiresIn: ttlSeconds });
}

export function verifyAuthToken(token: string): AuthUser {
  const decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
  const { sub, email, role } = decoded as Record<string, unknown>;
  return { sub: sub as string, email: email as string, role: role as AuthUser['role'] };
}
