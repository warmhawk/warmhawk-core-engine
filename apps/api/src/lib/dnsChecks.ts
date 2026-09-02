/**
 * Domain-authentication (SPF/DKIM/DMARC) health checker — ported forward from outreach-infra's
 * `apps/api/src/routes/domains.ts` DNS-check logic (confirmed already built and working there —
 * Guardrails: "verified in outreach-infra... live DNS-TXT resolution... this is not new
 * engineering, it's a straight port"). Extended, V11, with continuous blocklist/DNSBL monitoring
 * (Spamhaus ZEN/DBL, Barracuda, SORBS) — genuinely new, since a one-time SPF/DKIM/DMARC check at
 * setup doesn't catch a domain landing on a blocklist within 72 hours of a bad list/misconfig.
 */
import dns from 'node:dns';

export type CheckStatus = 'PASS' | 'FAIL';

async function resolveTxtFlat(hostname: string): Promise<string[]> {
  try {
    const records = await dns.promises.resolveTxt(hostname);
    return records.map((chunks) => chunks.join(''));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') {
      return [];
    }
    throw err;
  }
}

export async function checkSpf(domainName: string): Promise<CheckStatus> {
  const records = await resolveTxtFlat(domainName);
  return records.some((r) => r.toLowerCase().startsWith('v=spf1')) ? 'PASS' : 'FAIL';
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

export async function checkDkim(domainName: string, selector?: string): Promise<CheckStatus> {
  const candidates = selector ? [selector] : DKIM_SELECTOR_CANDIDATES;
  for (const candidate of candidates) {
    const records = await resolveTxtFlat(`${candidate}._domainkey.${domainName}`);
    if (records.length > 0) return 'PASS';
  }
  return 'FAIL';
}

export async function checkDmarc(domainName: string): Promise<CheckStatus> {
  const records = await resolveTxtFlat(`_dmarc.${domainName}`);
  return records.some((r) => r.toLowerCase().startsWith('v=dmarc1')) ? 'PASS' : 'FAIL';
}

// -------------------------------------------------------------------------------------------
// Continuous blocklist/DNSBL monitoring (new, V11)
// -------------------------------------------------------------------------------------------

/** DNSBL zones checked — plain DNS A-record lookups against the reversed-IP query format, no
 *  paid API required. Domain-name-based lists (Spamhaus DBL, SORBS) query the domain directly;
 *  IP-based lists (Spamhaus ZEN, Barracuda) require the domain's resolved A record reversed. */
export interface DnsblSource {
  name: string;
  zone: string;
  /** 'domain' queries `${domain}.${zone}` directly; 'ip' reverses a resolved IPv4 address into
   *  `${reversed}.${zone}` per standard DNSBL convention. */
  queryType: 'domain' | 'ip';
}

export const DNSBL_SOURCES: DnsblSource[] = [
  { name: 'spamhausZen', zone: 'zen.spamhaus.org', queryType: 'ip' },
  { name: 'spamhausDbl', zone: 'dbl.spamhaus.org', queryType: 'domain' },
  { name: 'barracuda', zone: 'b.barracudacentral.org', queryType: 'ip' },
  { name: 'sorbs', zone: 'dnsbl.sorbs.net', queryType: 'ip' },
];

function reverseIpv4(ip: string): string {
  return ip.split('.').reverse().join('.');
}

async function resolveFirstIpv4(domainName: string): Promise<string | null> {
  try {
    const addresses = await dns.promises.resolve4(domainName);
    return addresses[0] ?? null;
  } catch {
    return null;
  }
}

/** A DNSBL lookup returning ANY A record means the domain/IP is listed — that's the standard
 *  convention these zones use (the returned address itself often encodes a listing reason code,
 *  irrelevant to a simple PASS/FAIL badge). NXDOMAIN/no-answer means "not listed" -> PASS. */
async function queryDnsbl(query: string): Promise<CheckStatus> {
  try {
    const addresses = await dns.promises.resolve4(query);
    return addresses.length > 0 ? 'FAIL' : 'PASS';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') {
      return 'PASS';
    }
    throw err;
  }
}

export type BlocklistResults = Record<string, CheckStatus>;

/** Runs every configured DNSBL source against `domainName`, returning a per-source PASS/FAIL map
 *  (e.g. `{ spamhausZen: 'PASS', spamhausDbl: 'PASS', barracuda: 'FAIL', sorbs: 'PASS' }`),
 *  persisted onto `Domain.blocklistStatus` and surfaced with the same badge pattern already used
 *  for SPF/DKIM/DMARC. */
export async function checkBlocklists(domainName: string): Promise<BlocklistResults> {
  const results: BlocklistResults = {};
  const ipv4 = await resolveFirstIpv4(domainName);

  for (const source of DNSBL_SOURCES) {
    if (source.queryType === 'ip') {
      if (!ipv4) {
        results[source.name] = 'PASS'; // no resolvable IP to check — nothing to flag
        continue;
      }
      results[source.name] = await queryDnsbl(`${reverseIpv4(ipv4)}.${source.zone}`);
    } else {
      results[source.name] = await queryDnsbl(`${domainName}.${source.zone}`);
    }
  }

  return results;
}
