/**
 * Built-in unsubscribe link — the token that goes in the email, and the URL it lives at.
 *
 * A campaign with no `unsubscribeUrlTemplate` of its own gets
 * `https://${WARMHAWK_DOMAIN}/unsubscribe/<token>` in its footer and `List-Unsubscribe` header,
 * served by `routes/unsubscribe.ts`. The token is `<leadId>.<signature>`: the signature is an
 * HMAC over the lead id, so the route never acts on an id somebody made up, and the address
 * itself never appears in the URL.
 *
 * It never expires. CAN-SPAM needs the opt-out to work for at least 30 days after the send; an
 * email is read (and forwarded) long after that, and an opt-out that stopped working is worse
 * than one that works forever.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_BYTES = 16;

function getTokenSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

function sign(leadId: string): string {
  // The prefix keeps this signature from being valid as anything else signed with JWT_SECRET.
  return createHmac('sha256', getTokenSecret())
    .update(`unsubscribe:${leadId}`)
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString('base64url');
}

export function signUnsubscribeToken(leadId: string): string {
  return `${leadId}.${sign(leadId)}`;
}

/** The lead id a token was signed for, or null for anything malformed or forged. */
export function verifyUnsubscribeToken(token: string): string | null {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const leadId = token.slice(0, separator);
  const given = Buffer.from(token.slice(separator + 1), 'base64url');
  const expected = Buffer.from(sign(leadId), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return leadId;
}

/** The built-in unsubscribe URL for a lead, or null on an install with no `WARMHAWK_DOMAIN` —
 *  there is no public address to put in the email then, so the campaign needs its own link. */
export function hostedUnsubscribeUrl(leadId: string): string | null {
  const domain = process.env.WARMHAWK_DOMAIN?.trim();
  if (!domain) return null;
  return `https://${domain}/unsubscribe/${signUnsubscribeToken(leadId)}`;
}
