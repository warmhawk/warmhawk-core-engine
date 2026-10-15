/**
 * What the worker remembers about lead addresses, in Redis (10-15-26):
 *
 *   - Each upcoming lead's check verdict, from a look-ahead check a few leads before its turn
 *     (`precheckUpcomingLeads`). The send reuses it rather than asking the server twice, and the
 *     enqueuer knows which leads are risky before booking them.
 *   - How many times a lead whose server said "not now" (greylisting) has been put back to ask
 *     again. A delay, never a block: after the last try the lead is sent.
 *   - Whether each mailbox's last booked first email was risky, so the enqueuer can spread risky
 *     leads between confirmed ones instead of handing one mailbox a run of them.
 *
 * Risky = a server that says yes to every address (catch-all), or a provider that does and
 * bounces later (Yahoo, AOL). Risky leads are all still sent.
 */
import type IORedis from 'ioredis';
import { prisma } from '@warmhawk/db';
import {
  checkAddress,
  junkAddressReason,
  type AddressCheckConfig,
  type AddressCheckResult,
} from './addressCheck';

/** How long a verdict is trusted: a working address rarely dies within a day. */
const VERDICT_TTL_SECONDS = 24 * 3600;
const CATCH_ALL_DOMAIN_TTL_SECONDS = 7 * 24 * 3600;
const LAST_RISKY_TTL_SECONDS = 2 * 24 * 3600;
/** Greylisting servers take the second try after 5 to 30 minutes; three tries spread over about
 *  two hours cover the slow ones. */
export const MAX_UNKNOWN_RETRIES = 3;
const UNKNOWN_RETRY_MIN_MS = 30 * 60_000;
const UNKNOWN_RETRY_RANGE_MS = 30 * 60_000;
/** Upcoming leads looked at per look-ahead pass, and checked per pass. */
const PRECHECK_SCAN_SIZE = 50;
const PRECHECK_PER_PASS = 5;

/** Providers that accept every address when asked and bounce afterwards. att.net, sbcglobal.net
 *  and bellsouth.net are Yahoo-hosted; verizon.net is AOL-hosted. */
const UNPROBEABLE_DOMAINS = new Set([
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  'aim.com',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'bellsouth.net',
]);

export function emailDomain(email: string): string {
  return email
    .slice(email.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase();
}

export function isUnprobeableDomain(domain: string): boolean {
  return UNPROBEABLE_DOMAINS.has(domain) || /^yahoo\.[a-z.]+$/.test(domain);
}

const verdictKey = (leadId: string) => `addresscheck:verdict:${leadId}`;
const triesKey = (leadId: string) => `addresscheck:tries:${leadId}`;
const catchAllKey = (domain: string) => `addresscheck:catchall:${domain}`;
const lastRiskyKey = (mailboxId: string) => `mailbox:lastrisky:${mailboxId}`;

/** Saves a check's verdict for the lead, and marks its domain when the server takes everything.
 *  Never throws: what's remembered here only saves work, and a send must not fail over it. */
export async function rememberVerdict(
  redis: IORedis,
  leadId: string,
  email: string,
  result: AddressCheckResult,
): Promise<void> {
  try {
    await redis.set(verdictKey(leadId), JSON.stringify(result), 'EX', VERDICT_TTL_SECONDS);
    if (result.verdict === 'catch_all') {
      await redis.set(catchAllKey(emailDomain(email)), '1', 'EX', CATCH_ALL_DOMAIN_TTL_SECONDS);
    }
  } catch (err) {
    console.warn(`[worker] couldn't save lead ${leadId}'s address check:`, err);
  }
}

/** The lead's saved verdict when it's a clear one. An `unknown` is always asked again. */
export async function cachedVerdict(
  redis: IORedis,
  leadId: string,
): Promise<AddressCheckResult | null> {
  try {
    const raw = await redis.get(verdictKey(leadId));
    if (!raw) return null;
    const result = JSON.parse(raw) as AddressCheckResult;
    return result.verdict === 'unknown' ? null : result;
  } catch {
    return null;
  }
}

/** Counts one more "ask again later" for the lead. False once it has had its tries, or when the
 *  count can't be kept: send it. */
export async function takeUnknownRetry(redis: IORedis, leadId: string): Promise<boolean> {
  try {
    const tries = await redis.incr(triesKey(leadId));
    await redis.expire(triesKey(leadId), 12 * 3600);
    return tries <= MAX_UNKNOWN_RETRIES;
  } catch {
    return false;
  }
}

/** When a greylisted lead is tried again: 30 to 60 minutes on. */
export function unknownRetryAt(now: Date): Date {
  return new Date(now.getTime() + UNKNOWN_RETRY_MIN_MS + Math.random() * UNKNOWN_RETRY_RANGE_MS);
}

/** The leads, of those given, that are risky: a catch-all verdict or domain, a provider that
 *  can't be asked, or a check that never got a clear answer. */
export async function riskyLeadIds(
  redis: IORedis,
  leads: { id: string; email: string }[],
): Promise<Set<string>> {
  const risky = new Set<string>();
  if (leads.length === 0) return risky;
  const domains = leads.map((l) => emailDomain(l.email));
  const [verdicts, catchAll] = await Promise.all([
    redis.mget(...leads.map((l) => verdictKey(l.id))),
    redis.mget(...domains.map(catchAllKey)),
  ]);
  leads.forEach((lead, i) => {
    let verdict: string | undefined;
    try {
      verdict = verdicts[i]
        ? (JSON.parse(verdicts[i] as string) as AddressCheckResult).verdict
        : undefined;
    } catch {
      verdict = undefined;
    }
    if (
      verdict === 'catch_all' ||
      verdict === 'unknown' ||
      catchAll[i] === '1' ||
      isUnprobeableDomain(domains[i])
    ) {
      risky.add(lead.id);
    }
  });
  return risky;
}

/** Mailboxes whose last booked first email went to a risky lead. */
export async function lastRiskyMailboxes(
  redis: IORedis,
  mailboxIds: string[],
): Promise<Set<string>> {
  if (mailboxIds.length === 0) return new Set();
  const flags = await redis.mget(...mailboxIds.map(lastRiskyKey));
  return new Set(mailboxIds.filter((_, i) => flags[i] === '1'));
}

export async function markLastBooking(
  redis: IORedis,
  mailboxId: string,
  risky: boolean,
): Promise<void> {
  await redis.set(lastRiskyKey(mailboxId), risky ? '1' : '0', 'EX', LAST_RISKY_TTL_SECONDS);
}

/**
 * Checks the next few first emails due, before their turn, so the enqueuer knows which are risky
 * and the send doesn't wait on the check. Leads already checked within a day are skipped, and so
 * are junk addresses (the send stops those without asking anyone). Returns how many it checked.
 */
export async function precheckUpcomingLeads(
  redis: IORedis,
  config: AddressCheckConfig,
): Promise<number> {
  const upcoming = await prisma.lead.findMany({
    where: {
      campaign: { status: 'ACTIVE', pausedForBounceRate: false },
      OR: [{ status: 'UNTOUCHED' }, { status: 'QUEUED', queuedJobId: null }],
    },
    orderBy: { createdAt: 'asc' },
    take: PRECHECK_SCAN_SIZE,
    select: { id: true, email: true },
  });
  if (upcoming.length === 0) return 0;
  const known = await redis.mget(...upcoming.map((l) => verdictKey(l.id)));
  const todo = upcoming
    .filter((lead, i) => !known[i] && !junkAddressReason(lead.email))
    .slice(0, PRECHECK_PER_PASS);
  await Promise.all(
    todo.map(async (lead) => {
      const result = await checkAddress(lead.email, config);
      await rememberVerdict(redis, lead.id, lead.email, result);
    }),
  );
  return todo.length;
}
