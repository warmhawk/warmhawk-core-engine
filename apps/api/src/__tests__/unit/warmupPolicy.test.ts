/**
 * Warmup engine — unit tests for the pure rules in `lib/warmup/policy.ts`: the ramp, send
 * spacing, the 7-day health score, graduate/demote, the post-graduation campaign cap, and the
 * dashboard's next-step text. No I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  DAY_MS,
  campaignCapToday,
  checkedCount,
  dailyWarmupTarget,
  decideStatus,
  emptyCounts,
  healthScore,
  isSendDue,
  minSendGapMs,
  nextStepText,
  tallyPlacements,
  warmupDay,
  type PlacementCounts,
} from '../../lib/warmup/policy';

const NOW = new Date('2026-09-26T12:00:00Z');

function counts(partial: Partial<PlacementCounts>): PlacementCounts {
  return { ...emptyCounts(), ...partial };
}

describe('warmupDay', () => {
  it('is 0 before warmup starts', () => {
    expect(warmupDay(null, NOW)).toBe(0);
  });
  it('is 1 during the first 24 hours and counts up after', () => {
    expect(warmupDay(new Date(NOW.getTime() - 1000), NOW)).toBe(1);
    expect(warmupDay(new Date(NOW.getTime() - DAY_MS), NOW)).toBe(2);
    expect(warmupDay(new Date(NOW.getTime() - 13.5 * DAY_MS), NOW)).toBe(14);
  });
  it('never goes below 1 for a start time in the future (clock skew)', () => {
    expect(warmupDay(new Date(NOW.getTime() + DAY_MS), NOW)).toBe(1);
  });
});

describe('dailyWarmupTarget', () => {
  it('ramps from 2/day by 20% a day and caps at 20', () => {
    const ramp = Array.from({ length: 16 }, (_, i) => dailyWarmupTarget(i + 1, 'WARMUP'));
    expect(ramp).toEqual([2, 2, 3, 3, 4, 5, 6, 7, 9, 10, 12, 15, 18, 20, 20, 20]);
  });
  it('never grows more than ~20% day over day once past the small numbers', () => {
    for (let d = 6; d < 14; d++) {
      const today = dailyWarmupTarget(d, 'WARMUP');
      const tomorrow = dailyWarmupTarget(d + 1, 'WARMUP');
      expect(tomorrow / today).toBeLessThanOrEqual(1.34);
    }
  });
  it('drops to 3/day maintenance once ACTIVE and 0 when PAUSED', () => {
    expect(dailyWarmupTarget(30, 'ACTIVE')).toBe(3);
    expect(dailyWarmupTarget(5, 'PAUSED')).toBe(0);
  });
  it('treats day 0 as day 1', () => {
    expect(dailyWarmupTarget(0, 'WARMUP')).toBe(2);
  });
});

describe('send spacing', () => {
  it('spreads the daily target over a 16 hour window', () => {
    expect(minSendGapMs(16)).toBe(60 * 60 * 1000);
    expect(minSendGapMs(0)).toBe(Infinity);
  });
  it('is due for a first send, then waits out the gap, then stops at the target', () => {
    expect(isSendDue({ target: 4, sentToday: 0, lastSentAt: null, now: NOW })).toBe(true);
    const justSent = new Date(NOW.getTime() - 60 * 1000);
    expect(isSendDue({ target: 4, sentToday: 1, lastSentAt: justSent, now: NOW })).toBe(false);
    const longAgo = new Date(NOW.getTime() - 5 * 60 * 60 * 1000);
    expect(isSendDue({ target: 4, sentToday: 1, lastSentAt: longAgo, now: NOW })).toBe(true);
    expect(isSendDue({ target: 4, sentToday: 4, lastSentAt: longAgo, now: NOW })).toBe(false);
  });
});

describe('health score', () => {
  it('is null before anything is checked', () => {
    expect(healthScore(counts({ pending: 3, failed: 1, sent: 4 }))).toBeNull();
  });
  it('is inbox / (inbox + spam + missing), ignoring pending, unchecked and failed', () => {
    const c = counts({ inbox: 9, spam: 1, missing: 0, pending: 5, unchecked: 2, failed: 3 });
    expect(checkedCount(c)).toBe(10);
    expect(healthScore(c)).toBe(90);
  });
  it('counts a rescued email as spam', () => {
    const c = tallyPlacements([
      { placement: 'INBOX', rescued: false },
      { placement: 'SPAM', rescued: true },
    ]);
    expect(c.rescued).toBe(1);
    expect(healthScore(c)).toBe(50);
  });
  it('tallies every placement kind', () => {
    const c = tallyPlacements([
      { placement: 'INBOX', rescued: false },
      { placement: 'SPAM', rescued: false },
      { placement: 'MISSING', rescued: false },
      { placement: 'PENDING', rescued: false },
      { placement: 'UNCHECKED', rescued: false },
      { placement: 'FAILED', rescued: false },
    ]);
    expect(c).toEqual({
      sent: 6,
      inbox: 1,
      spam: 1,
      missing: 1,
      pending: 1,
      unchecked: 1,
      failed: 1,
      rescued: 0,
    });
  });
});

describe('decideStatus', () => {
  const ready = counts({ inbox: 19, spam: 1 });
  it('graduates at >=90% health, day >=14 and >=20 checked', () => {
    expect(decideStatus({ status: 'WARMUP', day: 14, counts: ready })).toBe('graduate');
  });
  it('does not graduate before day 14 even with perfect health', () => {
    expect(decideStatus({ status: 'WARMUP', day: 13, counts: counts({ inbox: 40 }) })).toBe('none');
  });
  it('does not graduate on too few checked emails', () => {
    expect(decideStatus({ status: 'WARMUP', day: 20, counts: counts({ inbox: 19 }) })).toBe('none');
  });
  it('does not graduate below 90%', () => {
    expect(
      decideStatus({ status: 'WARMUP', day: 20, counts: counts({ inbox: 17, spam: 3 }) }),
    ).toBe('none');
  });
  it('demotes an ACTIVE mailbox under 70% with >=10 checked', () => {
    expect(decideStatus({ status: 'ACTIVE', day: 30, counts: counts({ inbox: 6, spam: 4 }) })).toBe(
      'demote',
    );
  });
  it('does not demote on thin evidence or at exactly 70%', () => {
    expect(decideStatus({ status: 'ACTIVE', day: 30, counts: counts({ inbox: 3, spam: 6 }) })).toBe(
      'none',
    );
    expect(decideStatus({ status: 'ACTIVE', day: 30, counts: counts({ inbox: 7, spam: 3 }) })).toBe(
      'none',
    );
  });
  it('never acts without data or on a PAUSED mailbox', () => {
    expect(decideStatus({ status: 'WARMUP', day: 30, counts: emptyCounts() })).toBe('none');
    expect(
      decideStatus({ status: 'PAUSED', day: 30, counts: counts({ inbox: 1, spam: 20 }) }),
    ).toBe('none');
  });
});

describe('campaignCapToday', () => {
  it('leaves a hand-activated mailbox at its full cap', () => {
    expect(campaignCapToday(25, null, NOW)).toBe(25);
  });
  it('starts a graduated mailbox at 5 and grows 20%/day to its cap', () => {
    const grad = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
    expect(campaignCapToday(25, grad(0), NOW)).toBe(5);
    expect(campaignCapToday(25, grad(1), NOW)).toBe(6);
    expect(campaignCapToday(25, grad(5), NOW)).toBe(13);
    expect(campaignCapToday(25, grad(9), NOW)).toBe(25);
    expect(campaignCapToday(10, grad(30), NOW)).toBe(10);
  });
});

describe('nextStepText', () => {
  const base = {
    status: 'WARMUP' as const,
    warmupEnabled: true,
    partnerCount: 2,
    day: 9,
    counts: counts({ inbox: 20 }),
    campaignCap: 25,
    dailyCap: 25,
  };
  it('explains each blocked state', () => {
    expect(nextStepText({ ...base, status: 'PAUSED' })).toBe('Mailbox is paused');
    expect(nextStepText({ ...base, warmupEnabled: false })).toBe('Warmup is paused');
    expect(nextStepText({ ...base, partnerCount: 0 })).toBe('Add a second mailbox or a test inbox');
    expect(nextStepText({ ...base, counts: emptyCounts() })).toBe(
      'Measuring starts after the first check',
    );
  });
  it('tells a warming mailbox what it still needs', () => {
    expect(nextStepText({ ...base, counts: counts({ inbox: 8, spam: 2 }) })).toBe(
      'Needs 90%. Now at 80%.',
    );
    expect(nextStepText({ ...base, counts: counts({ inbox: 12 }) })).toBe(
      '8 more checked emails to graduate',
    );
    expect(nextStepText(base)).toBe('Graduates in 5 days');
    expect(nextStepText({ ...base, day: 13 })).toBe('Graduates in 1 day');
    expect(nextStepText({ ...base, day: 14 })).toBe('Graduates on the next check');
  });
  it('shows the ramping campaign cap once active', () => {
    expect(nextStepText({ ...base, status: 'ACTIVE', campaignCap: 9 })).toBe(
      'Campaign cap today: 9 of 25',
    );
    expect(nextStepText({ ...base, status: 'ACTIVE' })).toBe('Sending campaigns');
  });
});
