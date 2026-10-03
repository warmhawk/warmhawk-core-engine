/**
 * The name a mailbox's provider already shows for it, saved as its sender name when it connects.
 * Without one, sends go out with a bare address in From and `{{senderName}}` falls back to the
 * address's local part — both look automated in a cold email. Best effort: any failure here
 * returns null, the connect still succeeds, and the dashboard asks for the name instead.
 */
import type { FetchLike } from './microsoftOAuth';

/** Same limit `routes/mailboxes.ts` applies to a typed sender name. */
const SENDER_NAME_MAX = 80;

/** A provider-supplied display name, tidied, or null when it isn't usable as a From name. Control
 *  characters are dropped since this ends up in a header; an address is not a name. */
export function cleanProviderName(value: unknown, email: string): string | null {
  if (typeof value !== 'string') return null;
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.includes('@') || name.toLowerCase() === email.toLowerCase()) return null;
  return name.slice(0, SENDER_NAME_MAX).trim();
}

/** The display name Gmail puts in From for this address (Settings → Accounts → Send mail as).
 *  Covered by the `https://mail.google.com/` scope every Google mailbox already grants. */
export async function fetchGmailSendAsName(
  accessToken: string,
  email: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(
      `https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(email)}`,
      { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as { displayName?: unknown };
    return cleanProviderName(json.displayName, email);
  } catch {
    return null;
  }
}
