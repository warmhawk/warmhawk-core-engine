/**
 * Warmup engine — unit tests for `lib/warmup/composer.ts`: warmup emails read like ordinary
 * notes, vary between sends, and carry no fixed marker a provider could learn to filter on.
 */
import { describe, it, expect } from 'vitest';
import {
  WARMUP_SUBJECTS,
  composeWarmupEmail,
  displayNameFromEmail,
} from '../../lib/warmup/composer';

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('displayNameFromEmail', () => {
  it('turns a personal local part into a first name', () => {
    expect(displayNameFromEmail('jordan@acme.example')).toBe('Jordan');
    expect(displayNameFromEmail('JANE.doe@example.com')).toBe('Jane');
  });
  it('returns nothing for role addresses', () => {
    expect(displayNameFromEmail('hello@warmhawk.com')).toBe('');
    expect(displayNameFromEmail('support@x.io')).toBe('');
  });
});

describe('composeWarmupEmail', () => {
  it('addresses the recipient and signs as the sender', () => {
    const email = composeWarmupEmail({
      fromEmail: 'jordan@partner.example',
      toEmail: 'alex@acme.example',
      rng: () => 0,
    });
    expect(email.subject).toBe('Quick question about next week');
    expect(email.body.split('\n')[0]).toBe('Hi Alex,');
    expect(email.body.trim().endsWith('Jordan')).toBe(true);
  });

  it('uses a plain greeting for a role address and no signature name', () => {
    const email = composeWarmupEmail({
      fromEmail: 'hello@a.com',
      toEmail: 'info@b.com',
      rng: () => 0,
    });
    expect(email.body.startsWith('Hi,')).toBe(true);
    expect(email.body.trim().endsWith('Thanks,')).toBe(true);
  });

  it('varies across sends', () => {
    const rng = seeded(42);
    const subjects = new Set<string>();
    const bodies = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const e = composeWarmupEmail({ fromEmail: 'a@x.com', toEmail: 'b@y.com', rng });
      subjects.add(e.subject);
      bodies.add(e.body);
    }
    expect(subjects.size).toBeGreaterThanOrEqual(8);
    expect(bodies.size).toBeGreaterThanOrEqual(30);
  });

  it('never includes a warmup marker, token or link', () => {
    const rng = seeded(7);
    for (let i = 0; i < 100; i++) {
      const e = composeWarmupEmail({ fromEmail: 'a@x.com', toEmail: 'b@y.com', rng });
      const text = `${e.subject}\n${e.body}`.toLowerCase();
      expect(text).not.toMatch(/warm|token|http|unsubscribe|[0-9a-f]{8,}/);
    }
  });

  it('stays in range when rng returns values at the edge', () => {
    const e = composeWarmupEmail({
      fromEmail: 'a@x.com',
      toEmail: 'b@y.com',
      rng: () => 0.9999999,
    });
    expect(e.subject).toBe('Next steps');
  });

  it('skips subjects the recipient saw recently', () => {
    const avoid = new Set(WARMUP_SUBJECTS.slice(0, -1));
    const rng = seeded(3);
    for (let i = 0; i < 20; i++) {
      const e = composeWarmupEmail({
        fromEmail: 'a@x.com',
        toEmail: 'b@y.com',
        rng,
        avoidSubjects: avoid,
      });
      expect(e.subject).toBe(WARMUP_SUBJECTS[WARMUP_SUBJECTS.length - 1]);
    }
  });

  it('never picks an avoided subject while others are left', () => {
    const avoid = new Set(['A small update', 'Catching up', 'Quick question about next week']);
    const rng = seeded(11);
    for (let i = 0; i < 200; i++) {
      const e = composeWarmupEmail({
        fromEmail: 'a@x.com',
        toEmail: 'b@y.com',
        rng,
        avoidSubjects: avoid,
      });
      expect(avoid.has(e.subject)).toBe(false);
    }
  });

  it('falls back to the full list once the recipient has seen every subject', () => {
    const e = composeWarmupEmail({
      fromEmail: 'a@x.com',
      toEmail: 'b@y.com',
      rng: () => 0,
      avoidSubjects: new Set(WARMUP_SUBJECTS),
    });
    expect(e.subject).toBe(WARMUP_SUBJECTS[0]);
  });

  it('ignores avoided subjects that are not in the list', () => {
    const e = composeWarmupEmail({
      fromEmail: 'a@x.com',
      toEmail: 'b@y.com',
      rng: () => 0,
      avoidSubjects: new Set(['Something else entirely']),
    });
    expect(e.subject).toBe(WARMUP_SUBJECTS[0]);
  });
});
