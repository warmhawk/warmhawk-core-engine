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

// Providers don't agree on a selector name, so when the caller doesn't pin one down we probe the
// default selector of every provider we're likely to see in the wild and pass on the first usable
// key. Kept identical to `DKIM_SELECTORS` in warmhawk-probe, so WarmHawk's public domain check and
// this dashboard never disagree about the same domain.
export const DKIM_SELECTOR_CANDIDATES = [
  'default', // cPanel, Namecheap Private Email, many shared hosts
  'google', // Google Workspace
  'selector1', // Microsoft 365
  'selector2',
  'cf2024-1', // Cloudflare Email Routing
  'k1', // Mailchimp / Mailgun
  'k2',
  'k3',
  's1', // SendGrid
  's2',
  'mail', // Brevo (older setups), generic
  'dkim',
  'zmail', // Zoho
  'zoho',
  'hostingermail-a', // Hostinger
  'hostingermail-b',
  'hostingermail-c',
  'mx', // Mailgun
  'smtp',
  'pic',
  'mte1', // Mandrill
  'fm1', // Fastmail
  'fm2',
  'fm3',
  'protonmail', // Proton Mail
  'protonmail2',
  'protonmail3',
  'brevo1', // Brevo
  'brevo2',
  'resend', // Resend
  'hs1', // HubSpot
  'hs2',
  'sig1', // iCloud custom domains
] as const;

/** A selector is one or more DNS labels: letters, digits, hyphens, dots between labels. */
const SELECTOR_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Normalizes a customer-supplied selector; `null` for blank, `undefined` for not-a-selector. */
export function normalizeDkimSelector(input: unknown): string | null | undefined {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') return undefined;
  const value = input.trim().toLowerCase().replace(/\._domainkey(\..*)?$/, '');
  if (!value) return null;
  return value.length <= 253 && SELECTOR_PATTERN.test(value) ? value : undefined;
}

type DkimRecordKind = 'usable' | 'unusable';

/**
 * Classifies one TXT record found at a `_domainkey` name. `usable` can verify a signature;
 * `unusable` is a DKIM record with no key in it — RFC 6376 section 3.6.1: an empty `p=` means the
 * key has been REVOKED; `null` is not a DKIM key record at all (an unrelated TXT sharing the name,
 * or a wildcard). Counting any record as a key was a false pass, and with dozens of guessed names
 * the odds of hitting one go up — example.com, for one, publishes `"v=DKIM1; p="` at `default`.
 * Ported from warmhawk-probe, which caught this live.
 */
function classifyDkimRecord(record: string): DkimRecordKind | null {
  const value = record.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith('v=') && !lower.startsWith('v=dkim1')) return null;

  const tag = /(?:^|;)\s*p\s*=\s*([^;]*)/i.exec(value);
  if (!tag) return lower.startsWith('v=dkim1') ? 'unusable' : null;
  return tag[1].replace(/\s+/g, '') ? 'usable' : 'unusable';
}

function hasUsableKey(lookup: TxtLookup): boolean {
  return (
    lookup.outcome === 'records' && lookup.records.some((r) => classifyDkimRecord(r) === 'usable')
  );
}

/**
 * DKIM selectors cannot be enumerated from DNS — there is no record that lists them. So a miss
 * across our guesses means "we didn't find one", not "this domain has no DKIM", and it is
 * reported as PENDING. An explicit selector is different: the customer told us the name, so a
 * miss there (nothing published, or a revoked key) IS a real finding and is FAIL.
 */
export async function checkDkim(domainName: string, selector?: string | null): Promise<CheckStatus> {
  if (selector) {
    const lookup = await resolveTxtFlat(`${selector}._domainkey.${domainName}`);
    if (lookup.outcome === 'error') return 'PENDING';
    return hasUsableKey(lookup) ? 'PASS' : 'FAIL';
  }

  // All candidates in parallel — the sequential form cost one serial round trip per guess, which
  // is the whole latency budget of a refresh spent on guesses.
  const lookups = await Promise.all(
    DKIM_SELECTOR_CANDIDATES.map((candidate) =>
      resolveTxtFlat(`${candidate}._domainkey.${domainName}`),
    ),
  );

  return lookups.some(hasUsableKey) ? 'PASS' : 'PENDING';
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
  /** A name the zone always lists, per its operator's docs — proves the answers are real. */
  canary: string;
}

export const DNSBL_SOURCES: DnsblSource[] = [
  { name: 'spamhausDbl', zone: 'dbl.spamhaus.org', canary: 'dbltest.com' },
];

/**
 * Where DNSBL queries go. Spamhaus refuses queries arriving through public or shared resolvers:
 * Cloudflare 1.1.1.1 and Hetzner's resolvers answer `127.255.255.254` (so every domain read
 * PENDING forever), and Google 8.8.8.8 answers NXDOMAIN even for the zone's own test listing — a
 * green PASS for a domain that is in fact listed. Most installs sit behind exactly those resolvers.
 *
 * So the zone's own authoritative nameservers are asked directly, from this server's IP, which
 * Spamhaus answers for low-volume use. The NS set is looked up through the system resolver (NS
 * lookups are not refused) and cached for an hour. If that lookup fails, the system resolver is
 * used and the canary below decides whether its answers mean anything.
 */
const AUTHORITATIVE_CACHE_MS = 60 * 60 * 1000;
const authoritativeResolvers = new Map<string, { at: number; resolver: Promise<DnsblResolver> }>();

interface DnsblResolver {
  resolve4(hostname: string): Promise<string[]>;
}

async function buildAuthoritativeResolver(zone: string): Promise<DnsblResolver> {
  try {
    const nameservers = await dns.promises.resolveNs(zone);
    const addresses = (
      await Promise.all(nameservers.map((ns) => dns.promises.resolve4(ns).catch(() => [])))
    ).flat();
    const unique = [...new Set(addresses)];
    if (unique.length === 0) return dns.promises;
    const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers(unique);
    return resolver;
  } catch {
    return dns.promises;
  }
}

function resolverFor(zone: string): Promise<DnsblResolver> {
  const cached = authoritativeResolvers.get(zone);
  if (cached && Date.now() - cached.at < AUTHORITATIVE_CACHE_MS) return cached.resolver;
  const resolver = buildAuthoritativeResolver(zone);
  authoritativeResolvers.set(zone, { at: Date.now(), resolver });
  return resolver;
}

/** Test seam: forget cached nameserver sets. */
export function resetDnsblResolverCache(): void {
  authoritativeResolvers.clear();
}

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

async function queryDnsbl(resolver: DnsblResolver, query: string): Promise<CheckStatus> {
  try {
    return classifyDnsblAnswer(await resolver.resolve4(query));
  } catch (err) {
    // NXDOMAIN is the not-listed answer. Anything else — SERVFAIL, timeout, refusal — means the
    // lookup did not happen, which is not the same as a clean result.
    return isAbsent(err) ? 'PASS' : 'PENDING';
  }
}

/**
 * One source: the canary and the domain, asked of the same resolver. NXDOMAIN only means "not
 * listed" if the same resolver, asked about a name the zone always lists, says FAIL — otherwise it
 * is a resolver that hides listings, and its clean answer is PENDING, not PASS.
 */
async function checkSource(source: DnsblSource, domainName: string): Promise<CheckStatus> {
  const resolver = await resolverFor(source.zone);
  const [canary, result] = await Promise.all([
    queryDnsbl(resolver, `${source.canary}.${source.zone}`),
    queryDnsbl(resolver, `${domainName}.${source.zone}`),
  ]);
  if (canary !== 'FAIL') {
    // Drop the cached nameserver set so the next run looks them up again.
    authoritativeResolvers.delete(source.zone);
    return 'PENDING';
  }
  return result;
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
    DNSBL_SOURCES.map((source) => checkSource(source, domainName)),
  );

  const results: BlocklistResults = {};
  DNSBL_SOURCES.forEach((source, i) => {
    const outcome = settled[i];
    results[source.name] = outcome.status === 'fulfilled' ? outcome.value : 'PENDING';
  });

  return results;
}
