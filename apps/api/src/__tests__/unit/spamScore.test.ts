import { describe, it, expect } from 'vitest';
import { scoreContent } from '../../lib/spamScore';

describe('scoreContent — pre-send spam-word/content heuristic scorer', () => {
  it('scores a clean, professional email as low', () => {
    const result = scoreContent(
      'Hi Jane, I noticed your team is hiring for a VP of Sales role. We help companies like yours streamline outbound. Would you be open to a quick call next week?',
    );
    expect(result.band).toBe('low');
    expect(result.score).toBeLessThan(20);
  });

  it('flags known spam-trigger phrases', () => {
    const result = scoreContent('Act now! This is a risk-free, no obligation offer — buy now!');
    expect(result.issues.some((i) => i.category === 'trigger_phrase')).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('flags excessive ALL-CAPS words, ignoring benign acronyms', () => {
    const result = scoreContent('THIS IS AMAZING and our CEO loves the API and FAQ page');
    const capsIssue = result.issues.find((i) => i.category === 'all_caps');
    expect(capsIssue).toBeDefined();
    expect(capsIssue!.detail).not.toContain('CEO');
    expect(capsIssue!.detail).not.toContain('API');
  });

  it('flags excessive punctuation', () => {
    const result = scoreContent('Is this real?? Yes it is!!');
    expect(result.issues.some((i) => i.category === 'excessive_punctuation')).toBe(true);
  });

  it('flags more than 3 links', () => {
    const content = 'Check http://a.com and http://b.com and http://c.com and http://d.com';
    const result = scoreContent(content);
    expect(result.issues.some((i) => i.category === 'link_count')).toBe(true);
  });

  it('does not flag 3 or fewer links', () => {
    const content = 'Check http://a.com and http://b.com and http://c.com';
    const result = scoreContent(content);
    expect(result.issues.some((i) => i.category === 'link_count')).toBe(false);
  });

  it('flags urgency language', () => {
    const result = scoreContent('You must act immediately, this expires soon!');
    expect(result.issues.some((i) => i.category === 'urgency_language')).toBe(true);
  });

  it('caps the total score at 100', () => {
    const spammy = SPAM_SAMPLE.repeat(10);
    const result = scoreContent(spammy);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('bands a heavily spammy message as high', () => {
    const result = scoreContent(SPAM_SAMPLE);
    expect(result.band).toBe('high');
  });
});

const SPAM_SAMPLE =
  'ACT NOW!! BUY NOW!! GUARANTEED risk-free offer, no obligation, no credit check, ' +
  'CLICK HERE immediately, urgent, expires soon, http://a.com http://b.com http://c.com http://d.com http://e.com';
