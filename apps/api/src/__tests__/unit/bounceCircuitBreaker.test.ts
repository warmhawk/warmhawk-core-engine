import { describe, it, expect } from 'vitest';
import { evaluateBounceCircuitBreaker } from '../../lib/bounceCircuitBreaker';

describe('bounce/complaint circuit breaker', () => {
  it('does not pause a campaign with a bounce rate under the 5% threshold', () => {
    const result = evaluateBounceCircuitBreaker({ sent: 100, bounced: 3 });
    expect(result.bounceRate).toBeCloseTo(0.03);
    expect(result.shouldPause).toBe(false);
  });

  it('pauses a campaign whose bounce rate exceeds the 5% threshold with a sufficient sample', () => {
    const result = evaluateBounceCircuitBreaker({ sent: 100, bounced: 8 });
    expect(result.bounceRate).toBeCloseTo(0.08);
    expect(result.shouldPause).toBe(true);
  });

  it('does not pause when the sample size is too small, even if the raw rate exceeds threshold', () => {
    const result = evaluateBounceCircuitBreaker({ sent: 2, bounced: 1 }); // 50% bounce, but n=2
    expect(result.sampleSizeSufficient).toBe(false);
    expect(result.shouldPause).toBe(false);
  });

  it('handles zero sends without dividing by zero', () => {
    const result = evaluateBounceCircuitBreaker({ sent: 0, bounced: 0 });
    expect(result.bounceRate).toBe(0);
    expect(result.shouldPause).toBe(false);
  });

  it('respects a custom threshold and minimum sample size', () => {
    const result = evaluateBounceCircuitBreaker({ sent: 10, bounced: 2 }, 0.1, 10);
    expect(result.sampleSizeSufficient).toBe(true);
    expect(result.shouldPause).toBe(true); // 20% > 10% threshold
  });

  it('treats a rate exactly at the threshold as not exceeding it (strictly greater-than)', () => {
    const result = evaluateBounceCircuitBreaker({ sent: 100, bounced: 5 }, 0.05, 20);
    expect(result.bounceRate).toBeCloseTo(0.05);
    expect(result.shouldPause).toBe(false);
  });
});
