/**
 * Seed-Inbox Placement Test (Guardrails, V12) — unit tests for the pure folder-classification
 * logic (`lib/seedPlacement.ts`), per the task requirement: "Unit tests for the folder-
 * classification logic and the aggregation endpoint." No I/O, no database — mirrors the style of
 * `dnsChecks.test.ts`'s mocked-dependency-free pure-function tests.
 */
import { describe, it, expect } from 'vitest';
import { classifyFolder } from '../../lib/seedPlacement';

describe('classifyFolder (Seed-Inbox Placement Test folder classification)', () => {
  it('classifies INBOX (case-insensitive)', () => {
    expect(classifyFolder('INBOX')).toBe('INBOX');
    expect(classifyFolder('inbox')).toBe('INBOX');
    expect(classifyFolder('Inbox')).toBe('INBOX');
  });

  it('classifies common spam/junk folder names across providers', () => {
    expect(classifyFolder('Spam')).toBe('SPAM');
    expect(classifyFolder('Junk')).toBe('SPAM');
    expect(classifyFolder('Junk Email')).toBe('SPAM'); // Outlook/Microsoft 365
    expect(classifyFolder('[Gmail]/Spam')).toBe('SPAM');
    expect(classifyFolder('Bulk Mail')).toBe('SPAM'); // Yahoo
  });

  it('classifies Gmail Promotions tab variants', () => {
    expect(classifyFolder('Promotions')).toBe('PROMOTIONS');
    expect(classifyFolder('[Gmail]/Promotions')).toBe('PROMOTIONS');
    expect(classifyFolder('CategoryPromotions')).toBe('PROMOTIONS');
  });

  it('classifies an unrecognized folder as UNCLASSIFIED rather than guessing', () => {
    expect(classifyFolder('Archive')).toBe('UNCLASSIFIED');
    expect(classifyFolder('Some Custom Folder')).toBe('UNCLASSIFIED');
    expect(classifyFolder('')).toBe('UNCLASSIFIED');
  });

  it('is tolerant of surrounding whitespace', () => {
    expect(classifyFolder('  Spam  ')).toBe('SPAM');
  });

  it('does not partial-match an unrelated folder containing a substring (e.g. "Spammy Notes")', () => {
    // Exact-match per candidate, not substring — a folder literally named "Spammy Notes" should
    // not be misclassified as SPAM just because it contains "spam".
    expect(classifyFolder('Spammy Notes')).toBe('UNCLASSIFIED');
  });
});
