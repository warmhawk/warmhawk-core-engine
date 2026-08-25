/**
 * Bounce/complaint circuit breaker — Guardrails, Reputation protection: "auto-pause a campaign
 * (and flag the mailbox) if its rolling bounce rate exceeds a threshold (e.g. 5%) — using
 * `ExecutionLog.status = BOUNCED` data already tracked in the schema. This catches a bad/
 * purchased list before it trashes a domain's reputation, not after."
 *
 * Pure evaluation function, called by a route/worker step after computing the rolling bounce
 * rate from `ExecutionLog` rows for a campaign+mailbox pair — kept dependency-free here so the
 * threshold logic itself is unit-testable without a database.
 */
import { DEFAULT_BOUNCE_RATE_THRESHOLD, BOUNCE_RATE_MIN_SAMPLE_SIZE } from '../../../../constants';

export interface BounceRateSample {
  sent: number;
  bounced: number;
}

export interface CircuitBreakerResult {
  bounceRate: number;
  shouldPause: boolean;
  /** True only when the sample size is large enough to trust the rate — prevents a campaign
   *  pausing itself after e.g. 1 bounce out of 2 sends. */
  sampleSizeSufficient: boolean;
}

/** Evaluates whether a campaign/mailbox's rolling bounce rate has crossed the circuit-breaker
 *  threshold. Returns `shouldPause: false` whenever the sample size is too small to be a
 *  meaningful signal, even if the raw rate happens to exceed the threshold. */
export function evaluateBounceCircuitBreaker(
  sample: BounceRateSample,
  threshold: number = DEFAULT_BOUNCE_RATE_THRESHOLD,
  minSampleSize: number = BOUNCE_RATE_MIN_SAMPLE_SIZE,
): CircuitBreakerResult {
  const bounceRate = sample.sent === 0 ? 0 : sample.bounced / sample.sent;
  const sampleSizeSufficient = sample.sent >= minSampleSize;
  return {
    bounceRate,
    shouldPause: sampleSizeSufficient && bounceRate > threshold,
    sampleSizeSufficient,
  };
}
