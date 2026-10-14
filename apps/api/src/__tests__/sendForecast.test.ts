import { describe, it, expect } from 'vitest';
import { forecastSends, type ForecastCampaign } from '../lib/sendForecast';

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
});
