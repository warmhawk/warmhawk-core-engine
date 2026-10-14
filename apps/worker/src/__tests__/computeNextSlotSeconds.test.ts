import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeNextSlotSeconds } from '../computeNextSlotSeconds';

describe('computeNextSlotSeconds — cadence/jitter math', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a delay within the jitter band (150-570s) when the mailbox has never sent', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 50; i++) {
      const delay = computeNextSlotSeconds(null, now, null);
      expect(delay).toBeGreaterThanOrEqual(150);
      expect(delay).toBeLessThanOrEqual(570);
    }
  });

  it('enforces the 8-minute cadence floor after a recent send', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const lastSentAt = new Date(now.getTime() - 60 * 1000); // sent 1 minute ago
    for (let i = 0; i < 50; i++) {
      const delay = computeNextSlotSeconds(lastSentAt, now, null);
      // Must be at least (8min floor - 1min already elapsed) + jitter band minimum
      const minExpected = 7 * 60 + 150; // 420 + 150
      expect(delay).toBeGreaterThanOrEqual(minExpected - 5); // small tolerance for rounding
    }
  });

  it('never returns less than the 30-second absolute floor', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // minimizes jitter/noise contribution
    const now = new Date('2026-01-01T00:00:00.000Z');
    const delay = computeNextSlotSeconds(null, now, null);
    expect(delay).toBeGreaterThanOrEqual(30);
  });

  it('respects a pending reservation further in the future than the cadence floor', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const pendingReservationAt = new Date(now.getTime() + 20 * 60 * 1000); // 20 min from now
    const delay = computeNextSlotSeconds(null, now, pendingReservationAt);
    // Must be at least 20 minutes (1200s) plus jitter band minimum (150s)
    expect(delay).toBeGreaterThanOrEqual(1200 + 150 - 5);
  });

  it('does not let a pending reservation in the past reduce the delay below the jitter floor', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const pendingReservationAt = new Date(now.getTime() - 60 * 1000); // already in the past
    const delay = computeNextSlotSeconds(null, now, pendingReservationAt);
    expect(delay).toBeGreaterThanOrEqual(150 - 5);
  });

  it('produces varying delays across calls (jitter is actually randomized)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(computeNextSlotSeconds(null, now, null));
    }
    expect(delays.size).toBeGreaterThan(1);
  });

  it('keeps the 8-minute floor after a pending reservation, not just after a real send', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const pendingReservationAt = new Date(now.getTime() + 60 * 1000); // booked 1 min from now
    for (let i = 0; i < 50; i++) {
      const delay = computeNextSlotSeconds(null, now, pendingReservationAt);
      expect(delay).toBeGreaterThanOrEqual(60 + 8 * 60 + 150 - 5);
    }
  });

  it('spaces sends by the window spread when it is wider than the floor (±20%)', () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const lastSentAt = new Date(now.getTime() - 60 * 1000);
    const spreadMs = 30 * 60 * 1000;
    for (let i = 0; i < 50; i++) {
      const delay = computeNextSlotSeconds(lastSentAt, now, null, spreadMs);
      expect(delay).toBeGreaterThanOrEqual(0.8 * 30 * 60 - 60 - 5);
      expect(delay).toBeLessThanOrEqual(1.2 * 30 * 60 - 60 + 5);
    }
  });

  it('never goes under the floor and jitter when the spread is narrower', () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const lastSentAt = new Date(now.getTime() - 60 * 1000);
    for (let i = 0; i < 50; i++) {
      const delay = computeNextSlotSeconds(lastSentAt, now, null, 2 * 60 * 1000);
      expect(delay).toBeGreaterThanOrEqual(7 * 60 + 150 - 5);
    }
  });

  it('sends soon at the start of a window, however long ago the last send was', () => {
    const now = new Date('2026-01-01T09:00:00.000Z');
    const lastSentAt = new Date(now.getTime() - 16 * 60 * 60 * 1000);
    const delay = computeNextSlotSeconds(lastSentAt, now, null, 20 * 60 * 1000);
    expect(delay).toBeLessThanOrEqual(570);
  });
});
