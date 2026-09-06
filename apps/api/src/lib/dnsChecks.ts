/**
 * Domain-authentication (SPF/DKIM/DMARC) health checker, using live DNS-TXT resolution. Extended,
 * V11, with continuous blocklist/DNSBL monitoring — genuinely new, since a one-time SPF/DKIM/DMARC
 * check at setup doesn't catch a domain landing on a blocklist within 72 hours of a bad
 * list/misconfig.
 *
 * A note on the third status. Every check here can end in three states, not two: the thing is
 * configured, the thing is misconfigured, or *we could not find out*. Collapsing the third into
 * either of the first two produces a confident answer that is wrong — either a clean bill of health
 * for a domain nobody checked, or an accusation against a domain that is fine. `PENDING` is that
 * third state; it is already the `DnsRecordStatus` default in the schema, so nothing migrates.
 */
import dns from 'node:dns';

export type CheckStatus = 'PASS' | 'FAIL' | 'PENDING';

/** Codes that mean "this domain/IP has no record here" — a genuine not-listed / not-configured. */
const ABSENT_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

function isAbsent(err: unknown): boolean {
  return ABSENT_CODES.has((err as NodeJS.ErrnoException)?.code ?? '');
}

type TxtLookup =
  | { outcome: 'records'; records: string[] }
  | { outcome: 'absent' }
  | { outcome: 'error' };

/**
 * Resolves TXT and flattens the chunked form, distinguishing "no such record" from "the lookup
 * itself failed". SERVFAIL, timeouts and refusals are NOT absence — a resolver having a bad day
 * must not be reported as a customer misconfiguration.
 */
async function resolveTxtFlat(hostname: string): Promise<TxtLookup> {
  try {
    const records = await dns.promises.resolveTxt(hostname);
    return { outcome: 'records', records: records.map((chunks) => chunks.join('')) };
  } catch (err) {
    return isAbsent(err) ? { outcome: 'absent' } : { outcome: 'error' };
  }
}

export async function checkSpf(domainName: string): Promise<CheckStatus> {
  const lookup = await resolveTxtFlat(domainName);
  if (lookup.outcome === 'error') return 'PENDING';
  if (lookup.outcome === 'absent') return 'FAIL';
  return lookup.records.some((r) => r.toLowerCase().startsWith('v=spf1')) ? 'PASS' : 'FAIL';
}

// Providers don't agree on a selector name, so when the caller doesn't pin one down we probe
// every selector convention we're likely to see in the wild (Hostinger's three fixed selectors,
// Google, Microsoft 365, etc.) and pass on the first hit.
const DKIM_SELECTOR_CANDIDATES = [
  'default',
  'google',
  'selector1',
  'selector2',
  'hostingermail-a',
  'hostingermail-b',
  'hostingermail-c',
  'k1',
  'zmail',
];

/**
 * DKIM selectors cannot be enumerated from DNS — there is no record that lists them. So a miss
 * across our nine guesses means "we didn't find one", not "this domain has no DKIM", and it is
 * reported as PENDING. An explicit selector is different: the caller told us the name, so a miss
 * there IS a real finding and stays FAIL.
 */
export async function checkDkim(domainName: string, selector?: string): Promise<CheckStatus> {
  if (selector) {
    const lookup = await resolveTxtFlat(`${selector}._domainkey.${domainName}`);
    if (lookup.outcome === 'error') return 'PENDING';
    return lookup.outcome === 'records' && lookup.records.length > 0 ? 'PASS' : 'FAIL';
  }

  // Nine candidates in parallel — the sequential form cost up to nine serial round trips per
  // domain, which is the whole latency budget of a refresh spent on guesses.
  const lookups = await Promise.all(
    DKIM_SELECTOR_CANDIDATES.map((candidate) =>
      resolveTxtFlat(`${candidate}._domainkey.${domainName}`),
    ),
  );

  if (lookups.some((l) => l.outcome === 'records' && l.records.length > 0)) return 'PASS';
  return 'PENDING';
}

export async function checkDmarc(domainName: string): Promise<CheckStatus> {
  const lookup = await resolveTxtFlat(`_dmarc.${domainName}`);
  if (lookup.outcome === 'error') return 'PENDING';
  if (lookup.outcome === 'absent') return 'FAIL';
  return lookup.records.some((r) => r.toLowerCase().startsWith('v=dmarc1')) ? 'PASS' : 'FAIL';
}

// -------------------------------------------------------------------------------------------
// Continuous blocklist/DNSBL monitoring (V11; corrected)
// -------------------------------------------------------------------------------------------

/**
 * DNSBL zones checked — plain DNS lookups, no paid API required.
 *
 * Domain-level only, deliberately. The previous version resolved the domain's A record and
 * queried IP-based zones (Spamhaus ZEN, Barracuda) against it. A domain's A record is its
 * *website*, which for most customers is a CDN or shared host — it is not the address their mail
 * leaves from. An email-reputation verdict drawn from it is meaningless when clean and defamatory
 * when listed, and neither error is visible to the person reading the badge.
 *
 * Also dropped: `dnsbl.sorbs.net`, which has been retired and no longer serves the zone. Every
 * query NXDOMAIN'd, which this code read as "not listed" — a permanently green tick that had never
 * checked anything.
 *
 * The IP-side check returns in the probe service, aimed at the addresses a domain's SPF record
 * actually declares as senders.
 */
export interface DnsblSource {
  name: string;
  zone: string;
}

export const DNSBL_SOURCES: DnsblSource[] = [{ name: 'spamhausDbl', zone: 'dbl.spamhaus.org' }];

/**
 * Decodes a DNSBL answer. The `127.255.255.x` block is NOT a listing — it is the zone telling us
 * the query itself was rejected: 252 typo/malformed, 254 queried via a public or shared resolver,
 * 255 rate-limited or banned. Reading those as "listed" reports every domain checked as
 * blocklisted, and reading them as "not listed" hides the fact that monitoring has stopped
 * working. Both are worse than saying so.
 */
function classifyDnsblAnswer(addresses: string[]): CheckStatus {
  if (addresses.length === 0) return 'PASS';
  if (addresses.some((a) => a.startsWith('127.255.255.'))) return 'PENDING';
  if (addresses.every((a) => a.startsWith('127.'))) return 'FAIL';
  return 'PENDING'; // outside 127/8 — not a verdict this convention can express
}

async function queryDnsbl(query: string): Promise<CheckStatus> {
  try {
    return classifyDnsblAnswer(await dns.promises.resolve4(query));
  } catch (err) {
    // NXDOMAIN is the not-listed answer. Anything else — SERVFAIL, timeout, refusal — means the
    // lookup did not happen, which is not the same as a clean result.
    return isAbsent(err) ? 'PASS' : 'PENDING';
  }
}

export type BlocklistResults = Record<string, CheckStatus>;

/**
 * Runs every configured DNSBL source against `domainName`, returning a per-source
 * PASS/FAIL/PENDING map (e.g. `{ "spamhausDbl": "PASS" }`), persisted onto
 * `Domain.blocklistStatus` and surfaced with the same badge pattern already used for
 * SPF/DKIM/DMARC.
 *
 * Never throws. A rejected source becomes PENDING for that source alone — one zone timing out
 * must not fail the caller's whole domain refresh.
 */
export async function checkBlocklists(domainName: string): Promise<BlocklistResults> {
  const settled = await Promise.allSettled(
    DNSBL_SOURCES.map((source) => queryDnsbl(`${domainName}.${source.zone}`)),
  );

  const results: BlocklistResults = {};
  DNSBL_SOURCES.forEach((source, i) => {
    const outcome = settled[i];
    results[source.name] = outcome.status === 'fulfilled' ? outcome.value : 'PENDING';
  });

  return results;
}
