/**
 * Warmup engine — one tick, run every 10 minutes by the n8n `warmup-tick` workflow via
 * `POST /internal/warmup/tick`. Three steps, in this order so decisions use fresh data:
 *
 *   1. check  — find recently sent warmup emails on the recipient side, record INBOX / SPAM /
 *               MISSING, rescue spam back to INBOX
 *   2. decide — recompute each mailbox's 7-day health; graduate WARMUP -> ACTIVE or demote
 *               ACTIVE -> WARMUP (rules in policy.ts)
 *   3. send   — each due mailbox sends one warmup email to its next partner through the same
 *               `sendMail()` campaigns use (no campaignId, so no compliance footer, BCC or
 *               ExecutionLog — see mailSender.ts)
 *
 * Network I/O (SMTP/Graph send, IMAP read) comes in through `WarmupDeps` so integration tests can
 * run the real Postgres bookkeeping against a real or fake mail server.
 */
import { prisma, type Mailbox, type WarmupPlacement } from '@warmhawk/db';
import { sendMail, type SendMailInput } from '../mailSender';
import { composeWarmupEmail, type Rng } from './composer';
import {
  loadPartnerPool,
  partnersFor,
  choosePartner,
  mailboxCanWarm,
  type WarmupPartner,
} from './partners';
import { openInboxReader, type InboxReader, type PartnerRef } from './placement';
import { checkSampledPlacements } from '../seedPlacementPoller';
import {
  CHECK_AFTER_MS,
  CHECK_GIVE_UP_MS,
  DAY_MS,
  HEALTH_WINDOW_DAYS,
  UNCHECKED_AFTER_MS,
  campaignCapToday,
  checkedCount,
  dailyWarmupTarget,
  decideStatus,
  emptyCounts,
  healthScore,
  isSendDue,
  nextStepText,
  tallyPlacements,
  warmupDay,
  type PlacementCounts,
  type WarmupStage,
} from './policy';

export interface WarmupDeps {
  now: () => Date;
  send: (input: SendMailInput) => Promise<{ messageId: string }>;
  openReader: (partner: PartnerRef) => Promise<InboxReader>;
  rng: Rng;
}

export const defaultWarmupDeps: WarmupDeps = {
  now: () => new Date(),
  send: sendMail,
  openReader: openInboxReader,
  rng: Math.random,
};

export interface WarmupTickSummary {
  skipped?: 'busy';
  sent: number;
  failed: number;
  checked: number;
  rescued: number;
  missing: number;
  graduated: number;
  demoted: number;
  /** Sampled campaign copies checked in seed inboxes (see `seedPlacementPoller.ts`). */
  seedChecked: number;
  seedDropped: number;
}

/** Max placement checks per tick — keeps one tick well inside n8n's HTTP timeout. */
const CHECK_BATCH = 100;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function truncateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 500);
}

// ------------------------------------------------------------------------------------------------
// 1. check
// ------------------------------------------------------------------------------------------------

export async function checkPendingPlacements(
  deps: WarmupDeps,
): Promise<{ checked: number; rescued: number; missing: number }> {
  const now = deps.now();
  const pending = await prisma.warmupMessage.findMany({
    where: { placement: 'PENDING', sentAt: { lte: new Date(now.getTime() - CHECK_AFTER_MS) } },
    orderBy: { sentAt: 'asc' },
    take: CHECK_BATCH,
    include: { senderMailbox: { select: { email: true } } },
  });

  const groups = new Map<string, { ref: PartnerRef | null; messages: typeof pending }>();
  for (const m of pending) {
    const ref: PartnerRef | null = m.recipientMailboxId
      ? { kind: 'mailbox', id: m.recipientMailboxId }
      : m.recipientSeedAccountId
        ? { kind: 'seed', id: m.recipientSeedAccountId }
        : null;
    const key = ref ? `${ref.kind}:${ref.id}` : 'none';
    const group = groups.get(key) ?? { ref, messages: [] };
    group.messages.push(m);
    groups.set(key, group);
  }

  let checked = 0;
  let rescued = 0;
  let missing = 0;

  for (const { ref, messages } of groups.values()) {
    let reader: InboxReader | null = null;
    let openError: string | null = null;
    if (ref) {
      try {
        reader = await deps.openReader(ref);
      } catch (err) {
        openError = truncateError(err);
      }
    } else {
      openError = 'Recipient was removed before the check';
    }

    try {
      for (const m of messages) {
        const age = now.getTime() - m.sentAt.getTime();
        if (!reader) {
          if (age >= UNCHECKED_AFTER_MS) {
            await prisma.warmupMessage.update({
              where: { id: m.id },
              data: { placement: 'UNCHECKED', checkedAt: now, error: openError },
            });
          }
          continue;
        }

        let found;
        try {
          found = await reader.find({
            messageId: m.messageId,
            subject: m.subject,
            fromEmail: m.senderMailbox.email,
            sentAt: m.sentAt,
          });
        } catch (err) {
          if (age >= UNCHECKED_AFTER_MS) {
            await prisma.warmupMessage.update({
              where: { id: m.id },
              data: { placement: 'UNCHECKED', checkedAt: now, error: truncateError(err) },
            });
          }
          continue;
        }

        if (!found) {
          if (age >= CHECK_GIVE_UP_MS) {
            await prisma.warmupMessage.update({
              where: { id: m.id },
              data: { placement: 'MISSING', checkedAt: now },
            });
            checked += 1;
            missing += 1;
          }
          continue;
        }

        const placement: WarmupPlacement = found.inSpam ? 'SPAM' : 'INBOX';
        let wasRescued = false;
        let actionError: string | null = null;
        try {
          if (found.inSpam) {
            await reader.rescue(found);
            wasRescued = true;
          } else {
            await reader.markRead(found);
          }
        } catch (err) {
          actionError = truncateError(err);
        }
        await prisma.warmupMessage.update({
          where: { id: m.id },
          data: {
            placement,
            foundFolder: found.folder,
            rescued: wasRescued,
            checkedAt: now,
            error: actionError,
          },
        });
        checked += 1;
        if (wasRescued) rescued += 1;
      }
    } finally {
      if (reader) await reader.close().catch(() => undefined);
    }
  }

  return { checked, rescued, missing };
}

// ------------------------------------------------------------------------------------------------
// shared stats
// ------------------------------------------------------------------------------------------------

/** 7-day placement counts per sender mailbox. */
export async function loadWindowCounts(now: Date): Promise<Map<string, PlacementCounts>> {
  const since = new Date(now.getTime() - HEALTH_WINDOW_DAYS * DAY_MS);
  const rows = await prisma.warmupMessage.groupBy({
    by: ['senderMailboxId', 'placement', 'rescued'],
    where: { sentAt: { gte: since } },
    _count: { _all: true },
  });
  const out = new Map<string, PlacementCounts>();
  for (const r of rows) {
    const c = out.get(r.senderMailboxId) ?? emptyCounts();
    const partial = tallyPlacements(
      Array.from({ length: r._count._all }, () => ({ placement: r.placement, rescued: r.rescued })),
    );
    for (const k of Object.keys(c) as Array<keyof PlacementCounts>) c[k] += partial[k];
    out.set(r.senderMailboxId, c);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// 2. decide
// ------------------------------------------------------------------------------------------------

export async function applyGraduation(
  deps: WarmupDeps,
): Promise<{ graduated: number; demoted: number }> {
  const now = deps.now();
  const [mailboxes, counts] = await Promise.all([
    prisma.mailbox.findMany({
      where: {
        status: { in: ['WARMUP', 'ACTIVE'] },
        warmupEnabled: true,
        warmupStartedAt: { not: null },
      },
    }),
    loadWindowCounts(now),
  ]);

  let graduated = 0;
  let demoted = 0;
  for (const m of mailboxes) {
    const decision = decideStatus({
      status: m.status,
      day: warmupDay(m.warmupStartedAt, now),
      counts: counts.get(m.id) ?? emptyCounts(),
    });
    if (decision === 'graduate') {
      await prisma.mailbox.update({
        where: { id: m.id },
        data: { status: 'ACTIVE', warmupGraduatedAt: now },
      });
      graduated += 1;
    } else if (decision === 'demote') {
      await prisma.mailbox.update({
        where: { id: m.id },
        data: { status: 'WARMUP', warmupGraduatedAt: null },
      });
      demoted += 1;
    }
  }
  return { graduated, demoted };
}

// ------------------------------------------------------------------------------------------------
// 3. send
// ------------------------------------------------------------------------------------------------

async function recentRecipientCounts(
  senderMailboxId: string,
  now: Date,
): Promise<Map<string, number>> {
  const rows = await prisma.warmupMessage.groupBy({
    by: ['recipientEmail'],
    where: { senderMailboxId, sentAt: { gte: new Date(now.getTime() - DAY_MS) } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.recipientEmail, r._count._all]));
}

export type SendOneResult =
  | { status: 'sent'; messageId: string; to: string }
  | { status: 'failed'; error: string; to: string }
  | { status: 'no_partner' };

/** Sends one warmup email from `mailbox` to its next partner and records it. */
export async function sendOneWarmup(
  mailbox: Mailbox,
  pool: WarmupPartner[],
  deps: WarmupDeps,
): Promise<SendOneResult> {
  const now = deps.now();
  const partner = choosePartner({
    senderEmail: mailbox.email,
    partners: partnersFor(mailbox.email, pool),
    recentCounts: await recentRecipientCounts(mailbox.id, now),
  });
  if (!partner) return { status: 'no_partner' };

  if (!mailbox.warmupStartedAt) {
    await prisma.mailbox.update({ where: { id: mailbox.id }, data: { warmupStartedAt: now } });
  }

  const email = composeWarmupEmail({
    fromEmail: mailbox.email,
    toEmail: partner.email,
    rng: deps.rng,
  });
  const base = {
    senderMailboxId: mailbox.id,
    recipientMailboxId: partner.kind === 'mailbox' ? partner.id : null,
    recipientSeedAccountId: partner.kind === 'seed' ? partner.id : null,
    recipientEmail: partner.email,
    subject: email.subject,
    sentAt: now,
  };
  try {
    const result = await deps.send({ mailboxId: mailbox.id, to: partner.email, ...email });
    await prisma.warmupMessage.create({ data: { ...base, messageId: result.messageId } });
    return { status: 'sent', messageId: result.messageId, to: partner.email };
  } catch (err) {
    const error = truncateError(err);
    await prisma.warmupMessage.create({
      data: { ...base, placement: 'FAILED', checkedAt: now, error },
    });
    return { status: 'failed', error, to: partner.email };
  }
}

export async function sendDueWarmups(deps: WarmupDeps): Promise<{ sent: number; failed: number }> {
  const now = deps.now();
  const dayStart = startOfUtcDay(now);
  const [mailboxes, pool, todayRows, lastRows] = await Promise.all([
    prisma.mailbox.findMany({
      where: { warmupEnabled: true, status: { in: ['WARMUP', 'ACTIVE'] } },
    }),
    loadPartnerPool(),
    prisma.warmupMessage.groupBy({
      by: ['senderMailboxId'],
      where: { sentAt: { gte: dayStart } },
      _count: { _all: true },
    }),
    prisma.warmupMessage.groupBy({
      by: ['senderMailboxId'],
      where: { sentAt: { gte: new Date(now.getTime() - 2 * DAY_MS) } },
      _max: { sentAt: true },
    }),
  ]);
  const today = new Map(todayRows.map((r) => [r.senderMailboxId, r._count._all]));
  const last = new Map(lastRows.map((r) => [r.senderMailboxId, r._max.sentAt]));

  let sent = 0;
  let failed = 0;
  for (const m of mailboxes) {
    if (!mailboxCanWarm(m) || m.autoFlaggedAt) continue;
    const day = warmupDay(m.warmupStartedAt ?? now, now);
    const target = dailyWarmupTarget(day, m.status);
    if (
      !isSendDue({
        target,
        sentToday: today.get(m.id) ?? 0,
        lastSentAt: last.get(m.id) ?? null,
        now,
      })
    ) {
      continue;
    }
    const result = await sendOneWarmup(m, pool, deps);
    if (result.status === 'sent') sent += 1;
    else if (result.status === 'failed') failed += 1;
  }
  return { sent, failed };
}

// ------------------------------------------------------------------------------------------------
// tick
// ------------------------------------------------------------------------------------------------

/** One API process per instance, so an in-process flag is enough to stop a slow tick (IMAP
 *  timeouts) from overlapping the next scheduled one. */
let tickRunning = false;

export async function runWarmupTick(
  deps: WarmupDeps = defaultWarmupDeps,
): Promise<WarmupTickSummary> {
  if (tickRunning) {
    return {
      skipped: 'busy',
      sent: 0,
      failed: 0,
      checked: 0,
      rescued: 0,
      missing: 0,
      graduated: 0,
      demoted: 0,
      seedChecked: 0,
      seedDropped: 0,
    };
  }
  tickRunning = true;
  try {
    const check = await checkPendingPlacements(deps);
    const decide = await applyGraduation(deps);
    const send = await sendDueWarmups(deps);
    const seed = await checkSampledPlacements(deps);
    return { ...check, ...decide, ...send, ...seed };
  } finally {
    tickRunning = false;
  }
}

// ------------------------------------------------------------------------------------------------
// dashboard read model
// ------------------------------------------------------------------------------------------------

export interface WarmupMailboxView {
  mailboxId: string;
  email: string;
  provider: Mailbox['provider'];
  status: Mailbox['status'];
  warmupEnabled: boolean;
  stage: WarmupStage;
  day: number;
  warmupStartedAt: string | null;
  warmupGraduatedAt: string | null;
  todayTarget: number;
  sentToday: number;
  health: number | null;
  checked: number;
  counts: PlacementCounts;
  partnerCount: number;
  campaignCapToday: number;
  dailyCap: number;
  lastMessageAt: string | null;
  nextStep: string;
}

export interface WarmupOverview {
  summary: {
    warming: number;
    graduated: number;
    averageHealth: number | null;
    savedFromSpam: number;
    sent: number;
  };
  mailboxes: WarmupMailboxView[];
}

export async function getWarmupOverview(now: Date = new Date()): Promise<WarmupOverview> {
  const dayStart = startOfUtcDay(now);
  const [mailboxes, pool, counts, todayRows, lastRows] = await Promise.all([
    prisma.mailbox.findMany({ orderBy: { createdAt: 'asc' } }),
    loadPartnerPool(),
    loadWindowCounts(now),
    prisma.warmupMessage.groupBy({
      by: ['senderMailboxId'],
      where: { sentAt: { gte: dayStart }, placement: { not: 'FAILED' } },
      _count: { _all: true },
    }),
    prisma.warmupMessage.groupBy({ by: ['senderMailboxId'], _max: { sentAt: true } }),
  ]);
  const today = new Map(todayRows.map((r) => [r.senderMailboxId, r._count._all]));
  const last = new Map(lastRows.map((r) => [r.senderMailboxId, r._max.sentAt]));

  const views: WarmupMailboxView[] = mailboxes.map((m) => {
    const c = counts.get(m.id) ?? emptyCounts();
    const partnerCount = partnersFor(m.email, pool).length;
    const day = warmupDay(m.warmupStartedAt, now);
    const cap = campaignCapToday(m.dailyCap, m.warmupGraduatedAt, now);
    const stage: WarmupStage =
      m.status === 'PAUSED' || !m.warmupEnabled
        ? 'paused'
        : partnerCount === 0
          ? 'waiting_for_partner'
          : m.status === 'WARMUP'
            ? 'warming'
            : m.warmupGraduatedAt
              ? 'graduated'
              : 'active';
    return {
      mailboxId: m.id,
      email: m.email,
      provider: m.provider,
      status: m.status,
      warmupEnabled: m.warmupEnabled,
      stage,
      day,
      warmupStartedAt: m.warmupStartedAt?.toISOString() ?? null,
      warmupGraduatedAt: m.warmupGraduatedAt?.toISOString() ?? null,
      todayTarget: dailyWarmupTarget(Math.max(1, day), m.status),
      sentToday: today.get(m.id) ?? 0,
      health: healthScore(c),
      checked: checkedCount(c),
      counts: c,
      partnerCount,
      campaignCapToday: cap,
      dailyCap: m.dailyCap,
      lastMessageAt: last.get(m.id)?.toISOString() ?? null,
      nextStep: nextStepText({
        status: m.status,
        warmupEnabled: m.warmupEnabled,
        partnerCount,
        day,
        counts: c,
        campaignCap: cap,
        dailyCap: m.dailyCap,
      }),
    };
  });

  const measured = views.filter((v) => v.health !== null);
  return {
    summary: {
      warming: views.filter((v) => v.status === 'WARMUP').length,
      graduated: views.filter((v) => v.warmupGraduatedAt !== null && v.status === 'ACTIVE').length,
      averageHealth: measured.length
        ? Math.round(measured.reduce((s, v) => s + (v.health ?? 0), 0) / measured.length)
        : null,
      savedFromSpam: views.reduce((s, v) => s + v.counts.rescued, 0),
      sent: views.reduce((s, v) => s + v.counts.sent, 0),
    },
    mailboxes: views,
  };
}
