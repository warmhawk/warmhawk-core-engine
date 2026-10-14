import { describe, it, expect } from 'vitest';
import { spreadGapMs, selectNextMailbox, type MailboxCandidate } from '../enqueuer';

function candidate(overrides: Partial<MailboxCandidate>): MailboxCandidate {
  return {
    id: 'mbx_default',
    lastSentAt: null,
    sentToday: 0,
    dailyCap: 25,
    sortKeyMs: -Infinity,
    ...overrides,
  };
}

describe('selectNextMailbox — weighted (LRU + capacity-aware) rotation', () => {
  it('picks the least-recently-used mailbox first', () => {
    const candidates = [
      candidate({ id: 'mbx_recent', sortKeyMs: 1000 }),
      candidate({ id: 'mbx_oldest', sortKeyMs: 100 }),
      candidate({ id: 'mbx_middle', sortKeyMs: 500 }),
    ];
    const { chosen } = selectNextMailbox(candidates, 2000);
    expect(chosen?.id).toBe('mbx_oldest');
  });

  it('rotates across three mailboxes without repeating one before the others are used', () => {
    let candidates: MailboxCandidate[] = [
      candidate({ id: 'a', sortKeyMs: -Infinity }),
      candidate({ id: 'b', sortKeyMs: -Infinity }),
      candidate({ id: 'c', sortKeyMs: -Infinity }),
    ];
    const order: string[] = [];
    let slot = 1000;
    for (let i = 0; i < 6; i++) {
      const { chosen, remaining } = selectNextMailbox(candidates, slot);
      order.push(chosen!.id);
      candidates = remaining;
      slot += 1000;
    }
    // First 3 picks must be a, b, c in some order with no repeats; picks 4-6 likewise.
    const firstRound = order.slice(0, 3);
    const secondRound = order.slice(3, 6);
    expect(new Set(firstRound).size).toBe(3);
    expect(new Set(secondRound).size).toBe(3);
  });

  it('never assigns a mailbox that would exceed its daily cap, and removes it from the pool once capped', () => {
    let candidates: MailboxCandidate[] = [
      candidate({ id: 'low-cap', dailyCap: 1, sentToday: 0, sortKeyMs: -Infinity }),
      candidate({ id: 'high-cap', dailyCap: 10, sentToday: 0, sortKeyMs: -Infinity + 1 }),
    ];
    const { chosen: first, remaining: afterFirst } = selectNextMailbox(candidates, 1000);
    expect(first?.id).toBe('low-cap');
    // low-cap should now be removed since sentToday (1) >= dailyCap (1)
    expect(afterFirst.find((c) => c.id === 'low-cap')).toBeUndefined();

    const { chosen: second } = selectNextMailbox(afterFirst, 2000);
    expect(second?.id).toBe('high-cap');
  });

  it('returns null when the candidate pool is empty', () => {
    const { chosen, remaining } = selectNextMailbox([], 1000);
    expect(chosen).toBeNull();
    expect(remaining).toEqual([]);
  });

  it('advances the chosen mailbox sortKeyMs to the assigned slot time so it goes to the back of the rotation', () => {
    const candidates = [candidate({ id: 'only', sortKeyMs: -Infinity })];
    const { remaining } = selectNextMailbox(candidates, 5000);
    // sentToday incremented, but cap not reached (default 25) so it stays in the pool
    expect(remaining[0].sortKeyMs).toBe(5000);
    expect(remaining[0].sentToday).toBe(1);
  });
});

describe('spreadGapMs — spreading the remaining limit over the window', () => {
  const HOUR = 60 * 60 * 1000;
  const nowMs = Date.parse('2026-10-14T14:00:00Z');
  const open = (msLeft: number) => ({ open: true, msLeft, closesAt: null, nextOpenAt: null });

  it('is 0 with no schedule (always open)', () => {
    expect(spreadGapMs(open(Infinity), 25, [], nowMs)).toBe(0);
  });

  it('divides the time left by the sends left: 8 hours, 25 a day → about 19 minutes', () => {
    expect(spreadGapMs(open(8 * HOUR), 25, [], nowMs) / 60_000).toBeCloseTo(19.2, 1);
  });

  it('counts sends that still count against the limit at window end', () => {
    // 5 of a 10 limit sent an hour ago — still inside 24 hours when the window closes.
    const recent = Array.from({ length: 5 }, () => nowMs - HOUR);
    expect(spreadGapMs(open(5 * HOUR), 10, recent, nowMs)).toBe(HOUR);
  });

  it('frees room for sends that age out of the 24 hours before the window closes', () => {
    // 10 of 10 sent 22 hours ago: all age out within the next 4 hours of window.
    const old = Array.from({ length: 10 }, () => nowMs - 22 * HOUR);
    expect(spreadGapMs(open(4 * HOUR), 10, old, nowMs)).toBe(24 * 60_000);
  });
});
