/**
 * In-memory access-token cache for WarmHawk Connect mailboxes (design Section 3: "reused until
 * 5 min before expiry"). Every Connect refresh is a network round trip — through the relay on
 * warmhawk.com for Google, to Microsoft for Microsoft — so minting per send would cost one
 * round trip per email and, for Google, eat the relay's per-customer rate limit. The API and
 * the worker each keep their own copy; that's at most two refreshes per mailbox per hour.
 *
 * The key includes the mailbox's `oauthConnectedAt`, so reconnecting a mailbox never reuses a
 * token minted from the old grant — but Microsoft's refresh-token rotation (a new refresh token on
 * every refresh, same grant) keeps hitting the cache. Concurrent callers for the same key share
 * one in-flight mint instead of each starting their own.
 */

/** Reuse a cached token until this long before it expires. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface MintedAccessToken {
  accessToken: string;
  expiresInSeconds: number;
}

interface CacheEntry {
  accessToken: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string>>();

export function accessTokenCacheKey(
  mailboxId: string,
  resource: string,
  connectedAt: Date | null,
): string {
  return `${mailboxId}:${resource}:${connectedAt?.getTime() ?? 0}`;
}

export async function cachedAccessToken(
  key: string,
  mint: () => Promise<MintedAccessToken>,
  now: () => number = Date.now,
): Promise<string> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt - EXPIRY_MARGIN_MS > now()) return hit.accessToken;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const minting = mint()
    .then(({ accessToken, expiresInSeconds }) => {
      cache.set(key, { accessToken, expiresAt: now() + expiresInSeconds * 1000 });
      return accessToken;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, minting);
  return minting;
}

export function clearAccessTokenCache(): void {
  cache.clear();
  inFlight.clear();
}
