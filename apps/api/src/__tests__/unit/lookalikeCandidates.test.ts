/**
 * Unit tests for `lib/lookalikeCandidates.ts#generateCandidates` — pure, no network calls. Asserts
 * each documented typosquat-generation technique category produces at least the specific known
 * output named in that file's own header comment for the fixed input `example.com`, plus the
 * dedupe and self-exclusion guarantees.
 */
import { describe, it, expect } from 'vitest';
import { generateCandidates } from '../../lib/lookalikeCandidates';

describe('generateCandidates', () => {
  const candidates = generateCandidates('example.com');

  it('excludes the original domain itself', () => {
    expect(candidates).not.toContain('example.com');
  });

  it('produces no duplicates', () => {
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it('produces a character-swap variant (exmaple.com)', () => {
    expect(candidates).toContain('exmaple.com');
  });

  it('produces an omission variant (exampl.com)', () => {
    expect(candidates).toContain('exampl.com');
  });

  it('produces an insertion variant (exampple.com)', () => {
    expect(candidates).toContain('exampple.com');
  });

  it('produces an adjacent-keyboard-substitution variant (ecample.com)', () => {
    expect(candidates).toContain('ecample.com');
  });

  it('produces TLD-swap variants (example.net, example.co, example.org)', () => {
    expect(candidates).toContain('example.net');
    expect(candidates).toContain('example.co');
    expect(candidates).toContain('example.org');
  });

  it('produces a homoglyph variant (examp1e.com)', () => {
    expect(candidates).toContain('examp1e.com');
  });

  it('handles a domain with no TLD without throwing', () => {
    expect(() => generateCandidates('localhost')).not.toThrow();
  });

  it('is deterministic — same input always produces the same output set', () => {
    const again = generateCandidates('example.com');
    expect(new Set(again)).toEqual(new Set(candidates));
  });
});
