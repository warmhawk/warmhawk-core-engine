import { describe, it, expect } from 'vitest';
import {
  campaignSchedule,
  isValidTimezone,
  localParts,
  scheduleError,
  windowState,
  zonedInstant,
  type SendSchedule,
} from '../sendSchedule';

const WEEKDAYS_9_TO_5: SendSchedule = {
  timezone: 'America/Chicago',
  days: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
};

describe('windowState', () => {
  it('is always open with no schedule', () => {
    const state = windowState(null, new Date('2026-10-14T03:00:00Z'));
    expect(state.open).toBe(true);
    expect(state.msLeft).toBe(Infinity);
  });

  it('is open inside the hours on a ticked day, with the time left until close', () => {
    // Wed 14 Oct 2026, 10:00 CDT = 15:00 UTC.
    const state = windowState(WEEKDAYS_9_TO_5, new Date('2026-10-14T15:00:00Z'));
    expect(state.open).toBe(true);
    expect(state.closesAt?.toISOString()).toBe('2026-10-14T22:00:00.000Z');
    expect(state.msLeft).toBe(7 * 60 * 60 * 1000);
  });

  it('is closed before the start and says when it opens', () => {
    // Wed 14 Oct 2026, 7:00 CDT.
    const state = windowState(WEEKDAYS_9_TO_5, new Date('2026-10-14T12:00:00Z'));
    expect(state.open).toBe(false);
    expect(state.nextOpenAt?.toISOString()).toBe('2026-10-14T14:00:00.000Z');
  });

  it('skips unticked days: Friday evening opens on Monday', () => {
    // Fri 16 Oct 2026, 18:00 CDT.
    const state = windowState(WEEKDAYS_9_TO_5, new Date('2026-10-16T23:00:00Z'));
    expect(state.open).toBe(false);
    expect(state.nextOpenAt?.toISOString()).toBe('2026-10-19T14:00:00.000Z');
  });

  it('keeps 9 AM local across a daylight-saving change', () => {
    // US clocks fall back on Sun 1 Nov 2026: 9 AM is 14:00 UTC before, 15:00 UTC after.
    const before = windowState(WEEKDAYS_9_TO_5, new Date('2026-10-30T12:00:00Z'));
    const after = windowState(WEEKDAYS_9_TO_5, new Date('2026-11-01T12:00:00Z'));
    expect(before.nextOpenAt?.toISOString()).toBe('2026-10-30T14:00:00.000Z');
    expect(after.nextOpenAt?.toISOString()).toBe('2026-11-02T15:00:00.000Z');
  });

  it('reads the same hours in another zone when given one (a lead in London)', () => {
    // Wed 14 Oct 2026 15:00 UTC = 16:00 BST: open in London, closes 17:00 BST = 16:00 UTC.
    const state = windowState(WEEKDAYS_9_TO_5, new Date('2026-10-14T15:00:00Z'), 'Europe/London');
    expect(state.open).toBe(true);
    expect(state.closesAt?.toISOString()).toBe('2026-10-14T16:00:00.000Z');
  });

  it('works for a weekend outside Mon–Fri (Sun–Thu work week)', () => {
    const sunToThu: SendSchedule = {
      ...WEEKDAYS_9_TO_5,
      timezone: 'Asia/Dubai',
      days: [0, 1, 2, 3, 4],
    };
    // Fri 16 Oct 2026, 10:00 GST = 06:00 UTC — closed; opens Sun 18 Oct 09:00 GST.
    const state = windowState(sunToThu, new Date('2026-10-16T06:00:00Z'));
    expect(state.open).toBe(false);
    expect(state.nextOpenAt?.toISOString()).toBe('2026-10-18T05:00:00.000Z');
  });

  it('handles a window that runs to midnight', () => {
    const late: SendSchedule = { ...WEEKDAYS_9_TO_5, timezone: 'UTC', endMinute: 1440 };
    const state = windowState(late, new Date('2026-10-14T23:30:00Z'));
    expect(state.open).toBe(true);
    expect(state.msLeft).toBe(30 * 60 * 1000);
  });

  it('falls back to the schedule zone for an unknown lead zone', () => {
    const state = windowState(WEEKDAYS_9_TO_5, new Date('2026-10-14T15:00:00Z'), 'Mars/Base');
    expect(state.closesAt?.toISOString()).toBe('2026-10-14T22:00:00.000Z');
  });
});

describe('helpers', () => {
  it('localParts reads the wall clock in a zone', () => {
    expect(localParts('Asia/Kolkata', new Date('2026-10-14T20:00:00Z'))).toMatchObject({
      year: 2026,
      month: 10,
      day: 15,
      weekday: 4,
      minute: 90,
    });
  });

  it('zonedInstant turns a local time into the right instant', () => {
    expect(zonedInstant('Australia/Sydney', 2026, 10, 14, 9 * 60).toISOString()).toBe(
      '2026-10-13T22:00:00.000Z',
    );
  });

  it('isValidTimezone accepts IANA names only', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Nowhere/City')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(5)).toBe(false);
  });

  it('campaignSchedule is null for a campaign without one', () => {
    expect(
      campaignSchedule({
        sendTimezone: null,
        sendDays: [],
        sendStartMinute: null,
        sendEndMinute: null,
      }),
    ).toBeNull();
  });
});

describe('scheduleError', () => {
  const valid = {
    sendTimezone: 'Europe/Berlin',
    sendDays: [1, 2],
    sendStartMinute: 480,
    sendEndMinute: 960,
  };

  it('accepts a full schedule and no schedule', () => {
    expect(scheduleError(valid)).toBeNull();
    expect(scheduleError({ ...valid, sendTimezone: null })).toBeNull();
  });

  it.each([
    [{ sendTimezone: 'Berlin' }, /IANA/],
    [{ sendDays: [] }, /at least one day/],
    [{ sendDays: [7] }, /at least one day/],
    [{ sendDays: [1, 1] }, /at least one day/],
    [{ sendStartMinute: -1 }, /sendStartMinute/],
    [{ sendEndMinute: 1441 }, /sendEndMinute/],
    [{ sendStartMinute: 600, sendEndMinute: 600 }, /end after it starts/],
    [{ sendStartMinute: 9.5 }, /sendStartMinute/],
  ])('rejects %o', (patch, message) => {
    expect(scheduleError({ ...valid, ...patch })).toMatch(message);
  });
});
