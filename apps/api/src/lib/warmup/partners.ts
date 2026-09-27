/**
 * Warmup engine — who a mailbox sends its warmup email to. A partner is anything WarmHawk can read
 * over IMAP afterwards: another of the customer's own mailboxes, or an active seed account (a test
 * inbox added on the Seed Accounts page). No shared cross-customer network, by design.
 */
import { prisma } from '@warmhawk/db';

export interface WarmupPartner {
  kind: 'mailbox' | 'seed';
  id: string;
  email: string;
  domain: string;
}

function domainOf(email: string): string {
  return (email.split('@')[1] ?? '').toLowerCase();
}

/** Mailboxes WarmHawk can both send from and read over IMAP. */
export function mailboxCanWarm(m: {
  status: string;
  imapHost: string | null;
  imapPort: number | null;
  authUsername: string | null;
  oauthRefreshTokenEncrypted: string | null;
  authPasswordEncrypted: string | null;
}): boolean {
  return (
    m.status !== 'PAUSED' &&
    Boolean(m.imapHost && m.imapPort && m.authUsername) &&
    Boolean(m.oauthRefreshTokenEncrypted || m.authPasswordEncrypted)
  );
}

/** Every partner in this instance: usable mailboxes plus active seed accounts. */
export async function loadPartnerPool(): Promise<WarmupPartner[]> {
  const [mailboxes, seeds] = await Promise.all([
    prisma.mailbox.findMany({
      select: {
        id: true,
        email: true,
        status: true,
        imapHost: true,
        imapPort: true,
        authUsername: true,
        oauthRefreshTokenEncrypted: true,
        authPasswordEncrypted: true,
      },
    }),
    prisma.seedAccount.findMany({
      where: { isActive: true },
      select: { id: true, emailAddress: true },
    }),
  ]);
  return [
    ...mailboxes
      .filter(mailboxCanWarm)
      .map((m) => ({
        kind: 'mailbox' as const,
        id: m.id,
        email: m.email,
        domain: domainOf(m.email),
      })),
    ...seeds.map((s) => ({
      kind: 'seed' as const,
      id: s.id,
      email: s.emailAddress,
      domain: domainOf(s.emailAddress),
    })),
  ];
}

/** The partners a given sender may use: everyone in the pool except itself. */
export function partnersFor(senderEmail: string, pool: WarmupPartner[]): WarmupPartner[] {
  const self = senderEmail.toLowerCase();
  return pool.filter((p) => p.email.toLowerCase() !== self);
}

/**
 * Chooses the next recipient. Partners on a different domain come first (a mailbox emailing its
 * own domain proves little about outside placement); within that, the partner this sender has
 * emailed least in the last day, so volume spreads across every partner. Ties break on the
 * pool's order, which keeps the choice deterministic for tests.
 */
export function choosePartner(params: {
  senderEmail: string;
  partners: WarmupPartner[];
  recentCounts: Map<string, number>;
}): WarmupPartner | null {
  const { senderEmail, partners, recentCounts } = params;
  if (partners.length === 0) return null;
  const senderDomain = domainOf(senderEmail);
  const ranked = [...partners].sort((a, b) => {
    const aSame = a.domain === senderDomain ? 1 : 0;
    const bSame = b.domain === senderDomain ? 1 : 0;
    if (aSame !== bSame) return aSame - bSame;
    return (recentCounts.get(a.email) ?? 0) - (recentCounts.get(b.email) ?? 0);
  });
  return ranked[0] ?? null;
}
