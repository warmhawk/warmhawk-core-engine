import { describe, it, expect } from 'vitest';
import { closesTodayMs, limitFreesAt, stillCounted } from '../lib/rollingLimit';
import { usedAtClose } from '../lib/sendForecast';

const HOUR_MS = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso).getTime();
const chicago = {
  timezone: 'America/Chicago',
  days: [1, 2, 3, 4, 5],
  startMinute: 540,
  endMinute: 1020,
};

// The 10-16 case: graduated 10-15 afternoon, five sends that afternoon, one this morning, cap 6.
const now = new Date('2026-10-16T15:57:00Z');
const sends = [
  '2026-10-15T16:21:01Z',
  '2026-10-15T17:44:40Z',
  '2026-10-15T19:00:23Z',
  '2026-10-15T20:40:37Z',
  '2026-10-15T21:56:33Z',
  '2026-10-16T15:18:57Z',
].map(at);

describe('limitFreesAt', () => {
  it('is when the oldest counted send turns a day old, for a mailbox at its limit', () => {
    expect(limitFreesAt(sends, 6, now.getTime())).toBe(at('2026-10-16T16:21:01Z'));
  });

  it('waits for as many sends to age out as it is over the limit', () => {
    // Cap 4 with 6 counted: three must age out to leave one free.
    expect(limitFreesAt(sends, 4, now.getTime())).toBe(at('2026-10-16T19:00:23Z'));
  });

  it('is null with room now or a cap of 0', () => {
    expect(limitFreesAt(sends, 7, now.getTime())).toBeNull();
    expect(limitFreesAt(sends, 0, now.getTime())).toBeNull();
  });

  it('ignores sends over a day old', () => {
    expect(limitFreesAt([now.getTime() - 25 * HOUR_MS], 1, now.getTime())).toBeNull();
  });
});

describe('stillCounted', () => {
  it('counts the sends inside the 24 hours before a moment', () => {
    expect(stillCounted(sends, at('2026-10-16T22:00:00Z'))).toBe(1);
    expect(stillCounted(sends, now.getTime())).toBe(6);
  });
});

describe('closesTodayMs', () => {
  it("is the window's close in its own zone, or the UTC day's end with no schedule", () => {
    expect(closesTodayMs(chicago, now)).toBe(at('2026-10-16T22:00:00Z'));
    expect(closesTodayMs(null, now)).toBe(at('2026-10-17T00:00:00Z'));
  });
});

describe('usedAtClose', () => {
  it('counts what still uses the limit when the window closes', () => {
    const used = usedAtClose(now, new Map([['m1', sends]]), [
      { schedule: chicago, mailboxIds: ['m1'] },
    ]);
    expect(used.get('m1')).toBe(1);
  });

  it('frees a send that turns a day old before a late UTC close, though it is on the UTC day', () => {
    // A 6 PM Pacific close is 01:00 UTC tomorrow: the 00:30 UTC send is a day old by then.
    const pacific = { ...chicago, timezone: 'America/Los_Angeles', endMinute: 1080 };
    const times = [at('2026-10-16T00:30:00Z'), at('2026-10-16T01:30:00Z')];
    const used = usedAtClose(now, new Map([['m1', times]]), [
      { schedule: pacific, mailboxIds: ['m1'] },
    ]);
    expect(used.get('m1')).toBe(1);
  });
});
