/**
 * OAuth `state` param sign/verify — binds an OAuth callback back to the mailbox that initiated
 * the connect flow, and guards against CSRF on the callback (the state value itself is an
 * HMAC-signed, short-lived JWT, not a bare mailbox id passed in the clear).
 */
import jwt from 'jsonwebtoken';

export interface OAuthStatePayload {
  mailboxId: string;
  provider: 'GOOGLE_WORKSPACE' | 'MICROSOFT_365';
}

const STATE_TTL_SECONDS = 10 * 60; // 10 minutes — plenty for a consent-screen round trip

function getStateSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

export function signOAuthState(payload: OAuthStatePayload): string {
  return jwt.sign(payload, getStateSecret(), { algorithm: 'HS256', expiresIn: STATE_TTL_SECONDS });
}

export function verifyOAuthState(state: string): OAuthStatePayload {
  const decoded = jwt.verify(state, getStateSecret(), { algorithms: ['HS256'] });
  const { mailboxId, provider } = decoded as Record<string, unknown>;
  if (typeof mailboxId !== 'string' || typeof provider !== 'string') {
    throw new Error('Malformed OAuth state payload');
  }
  return { mailboxId, provider: provider as OAuthStatePayload['provider'] };
}
