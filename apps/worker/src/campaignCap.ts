/**
 * Post-graduation campaign ramp. A mailbox the warmup engine graduated (warmupGraduatedAt set)
 * starts campaigns at 5 sends/day and grows 20%/day up to its own dailyCap; one the customer
 * activated by hand keeps its full dailyCap. Mirrors `campaignCapToday` in
 * apps/api/src/lib/warmup/policy.ts — duplicated rather than imported because the worker doesn't
 * depend on apps/api (same convention as queue.ts's constants).
 */
const CAMPAIGN_RAMP_START = 5;
const CAMPAIGN_RAMP_GROWTH = 1.2;
const DAY_MS = 24 * 60 * 60 * 1000;

export function campaignCapToday(
  dailyCap: number,
  warmupGraduatedAt: Date | null,
  now: Date,
): number {
  if (!warmupGraduatedAt) return dailyCap;
  const days = Math.max(0, Math.floor((now.getTime() - warmupGraduatedAt.getTime()) / DAY_MS));
  return Math.min(dailyCap, Math.ceil(CAMPAIGN_RAMP_START * Math.pow(CAMPAIGN_RAMP_GROWTH, days)));
}
