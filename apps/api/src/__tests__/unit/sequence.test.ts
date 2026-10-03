import { describe, expect, it } from 'vitest';
import {
  followUpSubject,
  isDeterministicSubject,
  nextFollowUp,
  nextStepAtAfter,
  parseStepsInput,
} from '../../lib/sequence';

const steps = [
  { position: 1, waitDays: 3, body: 'Bumping this', aiRewrite: false },
  { position: 2, waitDays: 4, body: 'Last note', aiRewrite: false },
];

describe('sequence', () => {
  it('picks the follow-up after the emails already sent', () => {
    expect(nextFollowUp(steps, 0)).toBeNull();
    expect(nextFollowUp(steps, 1)?.position).toBe(1);
    expect(nextFollowUp(steps, 2)?.position).toBe(2);
    expect(nextFollowUp(steps, 3)).toBeNull();
  });

  it('times the next follow-up from the email just sent, and stops when none is left', () => {
    const sentAt = new Date('2026-10-01T10:00:00Z');
    expect(nextStepAtAfter(steps, 1, sentAt)?.toISOString()).toBe('2026-10-04T10:00:00.000Z');
    expect(nextStepAtAfter(steps, 2, sentAt)?.toISOString()).toBe('2026-10-05T10:00:00.000Z');
    expect(nextStepAtAfter(steps, 3, sentAt)).toBeNull();
    expect(nextStepAtAfter([], 1, sentAt)).toBeNull();
  });

  it('threads the subject with one "Re:", never two', () => {
    expect(followUpSubject('Quick idea for Acme')).toBe('Re: Quick idea for Acme');
    expect(followUpSubject('Re: Quick idea')).toBe('Re: Quick idea');
    expect(followUpSubject('AW: Quick idea')).toBe('Re: Quick idea');
  });

  it('treats merge fields as deterministic but spintax as not', () => {
    expect(isDeterministicSubject('Idea for {{company}}')).toBe(true);
    expect(isDeterministicSubject('{Hi|Hello} {{firstName}}')).toBe(false);
    expect(isDeterministicSubject('')).toBe(false);
    expect(isDeterministicSubject(null)).toBe(false);
  });

  it('validates a full list of follow-ups', () => {
    const ok = parseStepsInput([
      { waitDays: 3, body: 'a' },
      { waitDays: '4', body: '', aiRewrite: true },
    ]);
    expect(ok).toEqual({
      ok: true,
      steps: [
        { position: 1, waitDays: 3, body: 'a', aiRewrite: false },
        { position: 2, waitDays: 4, body: '', aiRewrite: true },
      ],
    });
    expect(parseStepsInput('nope').ok).toBe(false);
    expect(parseStepsInput([{ waitDays: 0 }]).ok).toBe(false);
    expect(parseStepsInput([{ waitDays: 31 }]).ok).toBe(false);
    expect(parseStepsInput([{ waitDays: 2.5 }]).ok).toBe(false);
    expect(parseStepsInput([{ waitDays: 2, body: 5 }]).ok).toBe(false);
    expect(parseStepsInput(Array.from({ length: 4 }, () => ({ waitDays: 2 }))).ok).toBe(false);
  });
});
