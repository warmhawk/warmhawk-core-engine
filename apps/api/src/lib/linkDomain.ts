/**
 * Link domains — the host a sending domain's emails point their unsubscribe link at, and the name
 * its SMTP connections give in EHLO.
 *
 * Without one, every email from an install names `WARMHAWK_DOMAIN`: an agency sending for three
 * brands from one server ties all three to its own name in the footer link, the
 * `List-Unsubscribe` header and the `Received:` header. A link domain on the brand's own zone
 * (`link.brand.com`, pointed at this server) keeps each brand's mail to its own name.
 *
 * The one rule: a link domain is used only after a check has reached THIS install through it. An
 * unsubscribe link that 404s breaks CAN-SPAM and gets the mail flagged, so an unchecked or failing
 * host keeps the `WARMHAWK_DOMAIN` link. The check fetches `https://<host>/unsubscribe/ping?n=<nonce>`
 * and expects back an HMAC of the nonce under this install's `JWT_SECRET`
 * (`routes/unsubscribe.ts`), so a host that answers from some other server never passes.
 */
import { createHmac, randomBytes } from 'node:crypto';

const CHECK_TIMEOUT_MS = 10_000;
const PROOF_BYTES = 16;

/** The fields a send needs to pick its host. */
export interface LinkDomainFields {
  linkDomain: string | null;
  linkDomainStatus: string;
}

/** Prisma `select` for the fields above. */
export const LINK_DOMAIN_SELECT = { linkDomain: true, linkDomainStatus: true } as const;

/** The host a domain's emails use: its link domain once checked, else the install's own domain,
 *  else null (no public address at all). */
export function linkHostFor(domain?: LinkDomainFields | null): string | null {
  if (domain?.linkDomain && domain.linkDomainStatus === 'PASS') return domain.linkDomain;
  return process.env.WARMHAWK_DOMAIN?.trim() || null;
}

const HOST_PATTERN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A typed host, cleaned up: lowercased, with a pasted scheme, path or trailing dot dropped. `null`
 *  for blank (clears it), `undefined` for something that isn't a host name. */
export function normalizeLinkDomain(input: unknown): string | null | undefined {
  if (input == null) return null;
  if (typeof input !== 'string') return undefined;
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
  if (!host) return null;
  return HOST_PATTERN.test(host) ? host : undefined;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

/** What `/unsubscribe/ping` answers for a nonce. The prefix keeps it from being valid as anything
 *  else signed with JWT_SECRET. */
export function linkDomainProof(nonce: string): string {
  return createHmac('sha256', getSecret())
    .update(`link-domain-check:${nonce}`)
    .digest()
    .subarray(0, PROOF_BYTES)
    .toString('base64url');
}

export interface LinkDomainCheck {
  status: 'PASS' | 'FAIL';
  error: string | null;
}

/** The low-level reason Node's fetch failed, in words a customer can act on. */
function describeFetchError(host: string, err: unknown): string {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return `${host} didn't answer within ${CHECK_TIMEOUT_MS / 1000} seconds`;
  }
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `${host} has no DNS record yet — add it, then check again`;
  }
  if (code === 'ECONNREFUSED') return `${host} points at a server that refuses HTTPS connections`;
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return `${host} has no valid HTTPS certificate yet — run "warmhawk link-domain add ${host}" on this server`;
  }
  return `Couldn't reach ${host}${code ? ` (${code})` : ''}`;
}

/** Fetches the ping page through `host` and says whether it reached this install. Never throws. */
export async function checkLinkDomain(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkDomainCheck> {
  const nonce = randomBytes(16).toString('base64url');
  let response: Response;
  try {
    response = await fetchImpl(`https://${host}/unsubscribe/ping?n=${nonce}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    return { status: 'FAIL', error: describeFetchError(host, err) };
  }
  if (response.status !== 200) {
    return {
      status: 'FAIL',
      error: `${host} answered with HTTP ${response.status} — it doesn't reach this server's unsubscribe page yet`,
    };
  }
  const body = (await response.text().catch(() => '')).trim();
  if (body !== linkDomainProof(nonce)) {
    return { status: 'FAIL', error: `${host} answers, but from a different server than this one` };
  }
  return { status: 'PASS', error: null };
}
