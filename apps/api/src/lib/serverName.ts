/**
 * Server name — the one host name this install introduces itself with: the EHLO name of a send
 * whose domain has no checked link domain, and the address check's EHLO when ADDRESS_CHECK_HELO
 * is blank (apps/worker/src/addressCheckName.ts).
 *
 * Receiving servers (Gmail, Outlook.com, Yahoo, Zoho...) stamp the connecting IP's reverse DNS
 * into `Received:`, and the big ones refuse an address-check probe whose name and reverse DNS
 * disagree. So `MAIL_SERVER_NAME` is used only once a check confirms it both ways: the name has
 * an A or AAAA record, and every address it points at has reverse DNS naming it back. Blank,
 * unchecked or failing, nothing changes: EHLO stays `WARMHAWK_DOMAIN`.
 *
 * The check runs when the API starts, from Domain Health's Check now, and again in the background
 * once the last result is an hour old and something asks for the name. A DNS server that can't
 * answer keeps the last result rather than flipping it.
 */
import { promises as dns } from 'node:dns';
import { prisma } from '@warmhawk/db';
import { normalizeLinkDomain, type LinkDomainFields } from './linkDomain';

const RECHECK_AFTER_MS = 60 * 60_000;
const CACHE_MS = 60_000;

export type ServerNameStatus = 'PENDING' | 'PASS' | 'FAIL';

export interface ServerNameCheck {
  status: 'PASS' | 'FAIL';
  /** One plain sentence on what to fix, `null` on PASS. */
  error: string | null;
}

/** What Domain Health shows. `name` is null when MAIL_SERVER_NAME is blank. */
export interface ServerNameState {
  name: string | null;
  status: ServerNameStatus;
  error: string | null;
  checkedAt: string | null;
}

/** The DNS lookups a check makes; a seam for tests. */
export interface ServerNameResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  reverse(ip: string): Promise<string[]>;
}

/** MAIL_SERVER_NAME as configured, lowercased, or null when blank. */
export function configuredServerName(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.MAIL_SERVER_NAME?.trim().toLowerCase().replace(/\.$/, '') || null;
}

/** "No such record" as opposed to "DNS didn't answer". */
function isNoRecord(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

/**
 * Checks a name both ways. `null` when DNS couldn't answer (a timeout, SERVFAIL): the caller keeps
 * the last result.
 */
export async function checkServerName(
  name: string,
  resolver: ServerNameResolver = dns,
): Promise<ServerNameCheck | null> {
  if (normalizeLinkDomain(name) !== name) {
    return { status: 'FAIL', error: `"${name}" isn't a host name. Example: mail.yourcompany.com` };
  }

  const ips: string[] = [];
  for (const lookup of [resolver.resolve4, resolver.resolve6]) {
    try {
      ips.push(...(await lookup.call(resolver, name)));
    } catch (err) {
      if (!isNoRecord(err)) return null;
    }
  }
  if (ips.length === 0) {
    return {
      status: 'FAIL',
      error: `${name} has no A record. Add one pointing at this server's IP address.`,
    };
  }

  for (const ip of ips) {
    let names: string[];
    try {
      names = await resolver.reverse(ip);
    } catch (err) {
      if (!isNoRecord(err)) return null;
      names = [];
    }
    const clean = names.map((n) => n.toLowerCase().replace(/\.$/, ''));
    if (clean.includes(name)) continue;
    return {
      status: 'FAIL',
      error:
        clean.length > 0
          ? `The reverse DNS of ${ip} is ${clean[0]}, not ${name}. Set it to ${name} in your server host's control panel.`
          : `${ip} has no reverse DNS. Set it to ${name} in your server host's control panel.`,
    };
  }
  return { status: 'PASS', error: null };
}

/** The saved result, for the name configured now. */
export async function serverNameState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerNameState> {
  const name = configuredServerName(env);
  if (!name) return { name: null, status: 'PENDING', error: null, checkedAt: null };
  const row = await prisma.instanceSettings.findUnique({
    where: { id: 'default' },
    select: {
      serverName: true,
      serverNameStatus: true,
      serverNameError: true,
      serverNameCheckedAt: true,
    },
  });
  if (!row || row.serverName !== name) {
    return { name, status: 'PENDING', error: null, checkedAt: null };
  }
  return {
    name,
    status: row.serverNameStatus,
    error: row.serverNameError,
    checkedAt: row.serverNameCheckedAt?.toISOString() ?? null,
  };
}

let cached: { state: ServerNameState; at: number } | null = null;
let running: Promise<ServerNameState> | null = null;

/** Checks the configured name now and saves the result. One check at a time. */
export function refreshServerName(
  resolver: ServerNameResolver = dns,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerNameState> {
  running ??= (async () => {
    const name = configuredServerName(env);
    if (name) {
      const check = await checkServerName(name, resolver);
      if (check) {
        const fields = {
          serverName: name,
          serverNameStatus: check.status,
          serverNameError: check.error,
          serverNameCheckedAt: new Date(),
        };
        await prisma.instanceSettings.upsert({
          where: { id: 'default' },
          create: { id: 'default', ...fields },
          update: fields,
        });
      }
    }
    const state = await serverNameState(env);
    cached = { state, at: Date.now() };
    return state;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** The server name once confirmed, else null. Cheap: read at most once a minute, and a result
 *  over an hour old is re-checked in the background. */
export async function checkedServerName(): Promise<string | null> {
  if (!configuredServerName()) return null;
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    cached = { state: await serverNameState(), at: Date.now() };
  }
  const { state } = cached;
  const checkedAt = state.checkedAt ? Date.parse(state.checkedAt) : 0;
  if (Date.now() - checkedAt > RECHECK_AFTER_MS) {
    refreshServerName().catch((err) => {
      console.error('[serverName] check failed:', err);
    });
  }
  return state.status === 'PASS' ? state.name : null;
}

/** Test seam: forget the in-process copy. */
export function resetServerNameCache(): void {
  cached = null;
}

/**
 * The name a send gives in EHLO: the sending domain's link domain once checked, else the
 * confirmed server name, else the install's own domain, else null (nodemailer's default).
 */
export async function ehloNameFor(domain?: LinkDomainFields | null): Promise<string | null> {
  if (domain?.linkDomain && domain.linkDomainStatus === 'PASS') return domain.linkDomain;
  return (await checkedServerName()) ?? (process.env.WARMHAWK_DOMAIN?.trim() || null);
}
