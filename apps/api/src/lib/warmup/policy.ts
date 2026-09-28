/**
 * Warmup engine — the pure rules. No I/O here, so every number the dashboard shows and every
 * graduate/demote decision is unit-testable on its own (see __tests__/unit/warmupPolicy.test.ts).
 *
 * The model (see z-notes 09-26-26-warmhawk-warmup-engine): a mailbox sends a few real emails a
 * day to partners it can read over IMAP, WarmHawk records where each one landed, and the mailbox
 * graduates WARMUP -> ACTIVE on a measured 7-day inbox rate — never on a calendar alone.
 */
import type { MailboxStatus, WarmupPlacement } from '@warmhawk/db';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Warmup volume: day 1 sends 2, growing 20% a day, capped at 20 — inside the 10-20%/day band
 *  the established warmup tools treat as safe. */
export const WARMUP_START_PER_DAY = 2;
export const WARMUP_GROWTH = 1.2;
export const WARMUP_MAX_PER_DAY = 20;
/** Once graduated, a mailbox keeps sending a few warmup emails a day so its health stays
 *  measured — that's what lets demotion work at all. */
export const MAINTENANCE_PER_DAY = 3;

/** Sends are spread across this many hours of the day rather than bursting. */
export const SEND_WINDOW_HOURS = 16;

/** Placement checks: start looking this long after the send; give up and call it MISSING after
 *  CHECK_GIVE_UP_MS; call it UNCHECKED when the recipient's IMAP stayed unreadable this long. */
export const CHECK_AFTER_MS = 3 * 60 * 1000;
export const CHECK_GIVE_UP_MS = 2 * 60 * 60 * 1000;
export const UNCHECKED_AFTER_MS = 6 * 60 * 60 * 1000;

export const HEALTH_WINDOW_DAYS = 7;
export const GRADUATE_MIN_HEALTH = 90;
export const GRADUATE_MIN_DAY = 14;
export const GRADUATE_MIN_CHECKED = 20;
export const DEMOTE_MAX_HEALTH = 70;
export const DEMOTE_MIN_CHECKED = 10;

/** Post-graduation campaign ramp: 5/day, +20%/day, never above the mailbox's own dailyCap.
 *  Mirrored in apps/worker/src/campaignCap.ts (the worker can't import apps/api). */
export const CAMPAIGN_RAMP_START = 5;
export const CAMPAIGN_RAMP_GROWTH = 1.2;

/** 1-based day number of a mailbox's warmup. Day 1 is the first 24 hours. */
export function warmupDay(warmupStartedAt: Date | null, now: Date): number {
  if (!warmupStartedAt) return 0;
  return Math.max(1, Math.floor((now.getTime() - warmupStartedAt.getTime()) / DAY_MS) + 1);
}

/** How many warmup emails a mailbox should send today. */
export function dailyWarmupTarget(day: number, status: MailboxStatus): number {
  if (status === 'PAUSED') return 0;
  if (status === 'ACTIVE') return MAINTENANCE_PER_DAY;
  const d = Math.max(1, day);
  return Math.min(
    WARMUP_MAX_PER_DAY,
    Math.round(WARMUP_START_PER_DAY * Math.pow(WARMUP_GROWTH, d - 1)),
  );
}

/** Minimum gap between two warmup sends from the same mailbox, so today's target is spread over
 *  the send window instead of going out in one burst. */
export function minSendGapMs(target: number): number {
  if (target <= 0) return Infinity;
  return Math.floor((SEND_WINDOW_HOURS * 60 * 60 * 1000) / target);
}

/** Whether a mailbox is due for its next warmup send right now. */
export function isSendDue(params: {
  target: number;
  sentToday: number;
  lastSentAt: Date | null;
  now: Date;
}): boolean {
  const { target, sentToday, lastSentAt, now } = params;
  if (target <= 0 || sentToday >= target) return false;
  if (!lastSentAt) return true;
  return now.getTime() - lastSentAt.getTime() >= minSendGapMs(target);
}

export interface PlacementCounts {
  sent: number;
  inbox: number;
  spam: number;
  missing: number;
  /** A delivery-failure report came back; it never reached the partner. */
  bounced: number;
  pending: number;
  unchecked: number;
  failed: number;
  rescued: number;
}

export function emptyCounts(): PlacementCounts {
  return {
    sent: 0,
    inbox: 0,
    spam: 0,
    missing: 0,
    bounced: 0,
    pending: 0,
    unchecked: 0,
    failed: 0,
    rescued: 0,
  };
}

/** Tallies a set of warmup messages. `sent` counts every attempt, failed sends included. */
export function tallyPlacements(
  messages: Array<{ placement: WarmupPlacement; rescued: boolean }>,
): PlacementCounts {
  const c = emptyCounts();
  for (const m of messages) {
    c.sent += 1;
    if (m.rescued) c.rescued += 1;
    switch (m.placement) {
      case 'INBOX':
        c.inbox += 1;
        break;
      case 'SPAM':
        c.spam += 1;
        break;
      case 'MISSING':
        c.missing += 1;
        break;
      case 'BOUNCED':
        c.bounced += 1;
        break;
      case 'PENDING':
        c.pending += 1;
        break;
      case 'UNCHECKED':
        c.unchecked += 1;
        break;
      case 'FAILED':
        c.failed += 1;
        break;
    }
  }
  return c;
}

/** Emails with a real placement answer — the health score's denominator. */
export function checkedCount(c: PlacementCounts): number {
  return c.inbox + c.spam + c.missing + c.bounced;
}

/** 7-day inbox rate, 0-100, or null before anything has been checked. A rescued email still
 *  counts as spam here: it landed there, rescuing it doesn't change that. */
export function healthScore(c: PlacementCounts): number | null {
  const checked = checkedCount(c);
  if (checked === 0) return null;
  return Math.round((c.inbox / checked) * 100);
}

export type WarmupDecision = 'graduate' | 'demote' | 'none';

export function decideStatus(params: {
  status: MailboxStatus;
  day: number;
  counts: PlacementCounts;
}): WarmupDecision {
  const { status, day, counts } = params;
  const health = healthScore(counts);
  const checked = checkedCount(counts);
  if (health === null) return 'none';
  if (
    status === 'WARMUP' &&
    day >= GRADUATE_MIN_DAY &&
    checked >= GRADUATE_MIN_CHECKED &&
    health >= GRADUATE_MIN_HEALTH
  ) {
    return 'graduate';
  }
  if (status === 'ACTIVE' && checked >= DEMOTE_MIN_CHECKED && health < DEMOTE_MAX_HEALTH) {
    return 'demote';
  }
  return 'none';
}

/** Campaign sends allowed today. A mailbox the customer activated by hand (never graduated by
 *  the engine) keeps its full dailyCap; one the engine graduated ramps up to it. */
export function campaignCapToday(
  dailyCap: number,
  warmupGraduatedAt: Date | null,
  now: Date,
): number {
  if (!warmupGraduatedAt) return dailyCap;
  const days = Math.max(0, Math.floor((now.getTime() - warmupGraduatedAt.getTime()) / DAY_MS));
  return Math.min(dailyCap, Math.ceil(CAMPAIGN_RAMP_START * Math.pow(CAMPAIGN_RAMP_GROWTH, days)));
}

export type WarmupStage = 'paused' | 'waiting_for_partner' | 'warming' | 'graduated' | 'active';

/** One plain-language line for the dashboard's "next step" cell. */
export function nextStepText(params: {
  status: MailboxStatus;
  warmupEnabled: boolean;
  partnerCount: number;
  day: number;
  counts: PlacementCounts;
  campaignCap: number;
  dailyCap: number;
}): string {
  const { status, warmupEnabled, partnerCount, day, counts, campaignCap, dailyCap } = params;
  if (status === 'PAUSED') return 'Mailbox is paused';
  if (!warmupEnabled) return 'Warmup is paused';
  if (partnerCount === 0) return 'Add a second mailbox or a test inbox';
  if (counts.bounced > 0) {
    return `${counts.bounced} bounced in 7 days. Open the send log to see why.`;
  }
  const health = healthScore(counts);
  if (status === 'ACTIVE') {
    return campaignCap < dailyCap
      ? `Campaign cap today: ${campaignCap} of ${dailyCap}`
      : 'Sending campaigns';
  }
  if (health === null) return 'Measuring starts after the first check';
  if (health < GRADUATE_MIN_HEALTH) return `Needs ${GRADUATE_MIN_HEALTH}%. Now at ${health}%.`;
  const checked = checkedCount(counts);
  if (checked < GRADUATE_MIN_CHECKED) {
    return `${GRADUATE_MIN_CHECKED - checked} more checked emails to graduate`;
  }
  const daysLeft = Math.max(0, GRADUATE_MIN_DAY - day);
  if (daysLeft > 0) return `Graduates in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  return 'Graduates on the next check';
}
