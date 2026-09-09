/**
 * RDAP registration lookup — Item 6 (lookalike/typosquat domain monitoring). Used by
 * `POST /internal/domains/scan-lookalikes` to find out whether a generated candidate domain
 * (`lib/lookalikeCandidates.ts`) has actually been registered.
 *
 * Two network calls, both plain `fetch`, no library:
 *   1. IANA's RDAP bootstrap registry (`https://data.iana.org/rdap/dns.json`) maps a TLD to the
 *      RDAP server base URL responsible for it. Cached in-process for the lifetime of this
 *      process — no Redis/DB caching needed, this file is re-imported fresh on every process
 *      restart and the bootstrap registry changes rarely.
 *   2. `GET {rdapServer}/domain/{candidate}` against that server. A `404` means unregistered; a
 *      `200` means registered.
 *
 * `fetchImpl` is injectable, mirroring `lib/alertWebhook.ts#postDomainChangeAlert`'s own
 * optional-second-parameter DI pattern (that file's header comment explains why this repo uses
 * that shape rather than mocking `global.fetch`) — so both the bootstrap lookup and the
 * per-domain query can be mocked in tests without touching the real network.
 *
 * 🔑 Critical correctness point: a network error, a timeout, or any response that is neither `404`
 * nor `200` (a 5xx from the RDAP server, a malformed bootstrap document, a TLD with no known RDAP
 * server, etc.) resolves to `"unknown"` — never `"unregistered"`. Silently treating an
 * inconclusive check as "unregistered" would read a real lookalike domain as safe; that's a
 * security-relevant bug, not just a gap in test coverage. Callers must not flip any "registered"
 * state on `"unknown"`.
 */

export type RdapRegistrationResult = 'registered' | 'unregistered' | 'unknown';

interface RdapBootstrapDocument {
  services?: Array<[tlds: string[], urls: string[]]>;
}

// A lookalike scan fans this out over dozens of candidates in one batch (see
// `POST /internal/domains/scan-lookalikes`) — one slow-to-not-respond RDAP server for a single
// candidate must not be able to stall the whole batch. 12s per request, same order of magnitude as
// `aiProviders/claude.ts`'s VALIDATE_TIMEOUT_MS, applied to both the IANA bootstrap fetch and the
// per-candidate RDAP query.
const RDAP_TIMEOUT_MS = 12_000;

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

let bootstrapCache: Map<string, string> | null = null;

function tldOf(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  const lastDot = trimmed.lastIndexOf('.');
  return lastDot === -1 ? trimmed : trimmed.slice(lastDot + 1);
}

/** Parses the IANA bootstrap document into a TLD -> RDAP base URL map. Malformed/unexpected shape
 *  yields an empty map (never throws) — the caller treats "no entry for this TLD" the same as any
 *  other lookup failure, resolving to `"unknown"`. */
function parseBootstrap(doc: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const services = (doc as RdapBootstrapDocument | undefined)?.services;
  if (!Array.isArray(services)) return map;

  for (const entry of services) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [tlds, urls] = entry;
    if (!Array.isArray(tlds) || !Array.isArray(urls) || urls.length === 0) continue;
    const baseUrl = urls[0];
    if (typeof baseUrl !== 'string') continue;
    for (const tld of tlds) {
      if (typeof tld === 'string') map.set(tld.toLowerCase(), baseUrl.replace(/\/+$/, ''));
    }
  }
  return map;
}

/** Fetches + caches the IANA RDAP bootstrap registry for this process's lifetime. Returns `null`
 *  (never throws) on any fetch/parse failure, so callers can uniformly resolve to `"unknown"`. */
async function getBootstrap(fetchImpl: typeof fetch): Promise<Map<string, string> | null> {
  if (bootstrapCache) return bootstrapCache;

  const { signal, clear } = withTimeout(RDAP_TIMEOUT_MS);
  try {
    const response = await fetchImpl('https://data.iana.org/rdap/dns.json', { signal });
    if (!response.ok) return null;
    const doc = await response.json();
    const parsed = parseBootstrap(doc);
    bootstrapCache = parsed;
    return parsed;
  } catch {
    return null;
  } finally {
    clear();
  }
}

/** Test-only escape hatch — clears the in-process bootstrap cache so a test can exercise the
 *  bootstrap-fetch path more than once. Not used by production code. */
export function resetRdapBootstrapCacheForTests(): void {
  bootstrapCache = null;
}

/**
 * Checks whether `candidateDomain` is registered, via RDAP. Resolves to `"unregistered"` only on
 * an explicit `404` from the RDAP server, `"registered"` only on an explicit `200`. Every other
 * outcome — no RDAP server known for the TLD, a bootstrap-fetch failure, a network error, a
 * timeout, or any other HTTP status — resolves to `"unknown"`.
 */
export async function checkRdapRegistration(
  candidateDomain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RdapRegistrationResult> {
  const tld = tldOf(candidateDomain);
  if (!tld) return 'unknown';

  const bootstrap = await getBootstrap(fetchImpl);
  const rdapServer = bootstrap?.get(tld);
  if (!rdapServer) return 'unknown';

  const { signal, clear } = withTimeout(RDAP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `${rdapServer}/domain/${candidateDomain.trim().toLowerCase()}`,
      { signal },
    );
    if (response.status === 404) return 'unregistered';
    if (response.status === 200) return 'registered';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clear();
  }
}
