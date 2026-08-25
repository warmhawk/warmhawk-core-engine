import { describe, it, expect } from 'vitest';
import { selectNextMailbox, type MailboxCandidate } from '../enqueuer';

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
