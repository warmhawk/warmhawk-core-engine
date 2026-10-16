import { describe, expect, it } from 'vitest';
import { parseReturnDate } from '../../lib/returnDate';
import { awayUntil } from '../../lib/replyOutcome';

// Thursday, October 15, 2026.
const received = new Date('2026-10-15T14:30:00.000Z');
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('parseReturnDate', () => {
  it.each([
    ['I am out of the office until October 20.', '2026-10-20'],
    ['Back on Oct 21st, 2026', '2026-10-21'],
    ['Out Oct. 15-20, limited access to email.', '2026-10-20'],
    ['I will return on 26 October.', '2026-10-26'],
    ['Returning 10/22.', '2026-10-22'],
    ['Back 22/10/2026', '2026-10-22'],
    ['Away until 2026-11-02 inclusive.', '2026-11-02'],
    ["I'm out October 15 to October 19 and back October 20.", '2026-10-20'],
    ["I'll be back Monday.", '2026-10-19'],
    ['Back tomorrow', '2026-10-16'],
  ])('%s → %s', (text, expected) => {
    expect(parseReturnDate(text, received)).toEqual(day(expected));
  });

  it('reads a date with no year as the next one, across the new year', () => {
    expect(parseReturnDate('Back January 4.', new Date('2026-12-20T09:00:00Z'))).toEqual(
      day('2027-01-04'),
    );
  });

  it('ignores dates before the reply, too far out, or not dates at all', () => {
    expect(parseReturnDate('Your ticket from October 1 is open.', received)).toBeNull();
    expect(parseReturnDate('On sabbatical until 2027-09-01.', received)).toBeNull();
    expect(parseReturnDate('Call me at 9.30 or 555 0199.', received)).toBeNull();
    expect(parseReturnDate('I am away from my desk.', received)).toBeNull();
  });
});

describe('awayUntil', () => {
  it('is the day after the return date', () => {
    expect(awayUntil('Out of office until October 20.', received)).toEqual(day('2026-10-21'));
  });

  it('is a week after the notice when it names no date', () => {
    expect(awayUntil('I am currently out of the office.', received)).toEqual(
      new Date('2026-10-22T14:30:00.000Z'),
    );
  });

  it('reads only what was typed, not the quoted email under it', () => {
    const raw = 'Out of office, back soon.\n\nOn Oct 14, Sam wrote:\n> Free on November 3?';
    expect(awayUntil(raw, received)).toEqual(new Date('2026-10-22T14:30:00.000Z'));
  });
});
