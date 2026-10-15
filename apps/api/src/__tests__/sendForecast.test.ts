import { describe, it, expect } from 'vitest';
import { forecastSends, offDays, type ForecastCampaign } from '../lib/sendForecast';

// A Wednesday; the forecast starts Thursday 2026-10-15.
const now = new Date('2026-10-14T17:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const campaign = (over: Partial<ForecastCampaign> = {}): ForecastCampaign => ({
  id: 'c1',
  maxNewLeadsPerDay: null,
  schedule: null,
  mailboxIds: ['m1'],
  waitDays: {},
  firstEmailsLeft: 100,
  ...over,
});
const mailbox = (id: string, dailyCap: number) => ({ id, dailyCap, warmupGraduatedAt: null });
const counts = (byDay: { count: number }[]) => byDay.map((d) => d.count);

describe('forecastSends', () => {
  it('lists every day after today, sending up to each mailbox cap', () => {
    const { byDay, byMailbox } = forecastSends(now, 3, [mailbox('m1', 5)], [campaign()], []);
    expect(byDay).toEqual([
      { day: '2026-10-15', count: 5 },
      { day: '2026-10-16', count: 5 },
      { day: '2026-10-17', count: 5 },
    ]);
    expect(byMailbox.get('m1')?.get('2026-10-16')).toBe(5);
  });

  it('stops when the leads run out', () => {
    const { byDay } = forecastSends(
      now,
      3,
      [mailbox('m1', 5)],
      [campaign({ firstEmailsLeft: 7 })],
      [],
    );
    expect(counts(byDay)).toEqual([5, 2, 0]);
  });

  it('follows the post-graduation ramp', () => {
    const graduated = {
      id: 'm1',
      dailyCap: 30,
      warmupGraduatedAt: new Date(now.getTime() - DAY_MS),
    };
    const { byDay } = forecastSends(now, 2, [graduated], [campaign()], []);
    // Ramp days 2 and 3: ceil(5 * 1.2^2) = 8, ceil(5 * 1.2^3) = 9.
    expect(counts(byDay)).toEqual([8, 9]);
  });

  it('holds first emails to the max new leads per day, spread over the mailboxes', () => {
    const { byDay, byMailbox } = forecastSends(
      now,
      1,
      [mailbox('m1', 10), mailbox('m2', 10)],
      [campaign({ mailboxIds: ['m1', 'm2'], maxNewLeadsPerDay: 6 })],
      [],
    );
    expect(counts(byDay)).toEqual([6]);
    expect(byMailbox.get('m1')?.get('2026-10-15')).toBe(3);
    expect(byMailbox.get('m2')?.get('2026-10-15')).toBe(3);
  });

  it('sends nothing on days the campaign is off', () => {
    const weekdays = {
      timezone: 'America/Chicago',
      days: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 1020,
    };
    const { byDay } = forecastSends(
      now,
      5,
      [mailbox('m1', 5)],
      [campaign({ schedule: weekdays })],
      [],
    );
    // Thu, Fri, Sat, Sun, Mon.
    expect(counts(byDay)).toEqual([5, 5, 0, 0, 5]);
  });

  it('sends due follow-ups first, from their own mailbox, and books the next step', () => {
    const { byDay, byMailbox } = forecastSends(
      now,
      3,
      [mailbox('m1', 2), mailbox('m2', 5)],
      [campaign({ mailboxIds: ['m2'], firstEmailsLeft: 0, waitDays: { 1: 1, 2: 2 } })],
      [
        { campaignId: 'c1', mailboxId: 'm1', stepsSent: 1, dueAtMs: now.getTime() - DAY_MS },
        { campaignId: 'c1', mailboxId: 'm1', stepsSent: 1, dueAtMs: now.getTime() },
        { campaignId: 'c1', mailboxId: 'm1', stepsSent: 1, dueAtMs: now.getTime() },
      ],
    );
    // Day 1: two fit m1's cap of 2, one waits. Day 2: the waiting one. Day 3: the first two's step 2.
    expect(counts(byDay)).toEqual([2, 1, 2]);
    expect(byMailbox.get('m2')).toBeUndefined();
  });

  it("starts a first email's follow-ups after the step's wait", () => {
    const { byDay } = forecastSends(
      now,
      3,
      [mailbox('m1', 10)],
      [campaign({ firstEmailsLeft: 2, waitDays: { 1: 2 } })],
      [],
    );
    expect(counts(byDay)).toEqual([2, 0, 2]);
  });

  it('shares a mailbox between campaigns', () => {
    const { byDay } = forecastSends(
      now,
      1,
      [mailbox('m1', 4)],
      [campaign({ id: 'a' }), campaign({ id: 'b' })],
      [],
    );
    expect(counts(byDay)).toEqual([4]);
  });

  it('skips follow-ups from a mailbox that can no longer send', () => {
    const { byDay } = forecastSends(
      now,
      1,
      [mailbox('m1', 5)],
      [campaign({ firstEmailsLeft: 0 })],
      [{ campaignId: 'c1', mailboxId: 'gone', stepsSent: 1, dueAtMs: now.getTime() }],
    );
    expect(counts(byDay)).toEqual([0]);
  });

  describe('with what each mailbox used today', () => {
    const weekdays = {
      timezone: 'America/Chicago',
      days: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 1020,
    };

    it("puts the rest of today first: each mailbox's cap less what it sent or booked", () => {
      const { byDay, byMailbox } = forecastSends(
        now,
        1,
        [mailbox('m1', 5), mailbox('m2', 5)],
        [campaign({ mailboxIds: ['m1', 'm2'] })],
        [],
        new Map([['m1', 3]]),
      );
      expect(byDay).toEqual([
        { day: '2026-10-14', count: 7 },
        { day: '2026-10-15', count: 10 },
      ]);
      expect(byMailbox.get('m1')?.get('2026-10-14')).toBe(2);
    });

    it('expects a full day before the window opens and nothing once it has closed', () => {
      const run = (at: string) =>
        counts(
          forecastSends(
            new Date(at),
            1,
            [mailbox('m1', 5)],
            [campaign({ schedule: weekdays })],
            [],
            new Map(),
          ).byDay,
        );
      // 6:58 AM and 6 PM in Chicago on a Wednesday.
      expect(run('2026-10-14T11:58:00Z')).toEqual([5, 5]);
      expect(run('2026-10-14T23:00:00Z')).toEqual([0, 5]);
    });

    it('expects nothing today on a day the campaign is off', () => {
      // Saturday noon in Chicago.
      const { byDay } = forecastSends(
        new Date('2026-10-17T17:00:00Z'),
        2,
        [mailbox('m1', 5)],
        [campaign({ schedule: weekdays })],
        [],
        new Map(),
      );
      // Sat, Sun, Mon.
      expect(counts(byDay)).toEqual([0, 0, 5]);
    });

    it('lists the days no campaign sends on, today included', () => {
      const { offDays: off } = forecastSends(
        now,
        5,
        [mailbox('m1', 5)],
        [campaign({ schedule: weekdays })],
        [],
        new Map(),
      );
      // Wed through Mon: only the weekend is off.
      expect(off).toEqual(['2026-10-17', '2026-10-18']);
    });

    it("takes today's sends out of the leads left for later days", () => {
      const { byDay } = forecastSends(
        now,
        2,
        [mailbox('m1', 5)],
        [campaign({ firstEmailsLeft: 7 })],
        [],
        new Map([['m1', 1]]),
      );
      expect(counts(byDay)).toEqual([4, 3, 0]);
    });
  });

  describe('offDays', () => {
    const weekdays = {
      timezone: 'America/Chicago',
      days: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 1020,
    };
    const sat = Date.UTC(2026, 9, 17);

    it('is on only when every campaign is off that day', () => {
      const weekend = { ...weekdays, days: [0, 6] };
      expect(offDays([{ schedule: weekdays }], sat, 3)).toEqual(['2026-10-17', '2026-10-18']);
      expect(offDays([{ schedule: weekdays }, { schedule: weekend }], sat, 3)).toEqual([]);
      expect(offDays([{ schedule: weekdays }, { schedule: null }], sat, 3)).toEqual([]);
    });

    it('marks nothing when no campaign is active', () => {
      expect(offDays([], sat, 3)).toEqual([]);
    });
  });
});
