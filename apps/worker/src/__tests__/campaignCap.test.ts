import { describe, it, expect } from 'vitest';
import { campaignCapToday } from '../campaignCap';

const NOW = new Date('2026-09-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('campaignCapToday (worker mirror of the warmup policy)', () => {
  it('keeps the full cap for a mailbox activated by hand', () => {
    expect(campaignCapToday(25, null, NOW)).toBe(25);
  });
  it('ramps a graduated mailbox from 5/day by 20%/day up to its cap', () => {
    const caps = [0, 1, 2, 5, 9, 20].map((d) =>
      campaignCapToday(25, new Date(NOW.getTime() - d * DAY), NOW),
    );
    expect(caps).toEqual([5, 6, 8, 13, 25, 25]);
  });
});
