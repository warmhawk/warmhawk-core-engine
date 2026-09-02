/**
 * Cadence/jitter math — ported forward from outreach-infra's `apps/api/src/worker/
 * computeNextSlotSeconds.ts` unchanged (verified already built — Competitor Pain Points #12:
 * "Lemlist pushes unsafe daily send volumes on new domains" / "computeNextSlotSeconds.ts enforces
 * an 8-min cadence floor + jitter"). Pure function, no I/O, fully unit-testable.
 */
const CADENCE_FLOOR_MS = 8 * 60 * 1000; // 8-minute floor since this mailbox's last send
const JITTER_BASE_SECONDS = 240; // jitter band: 240-480s
const JITTER_RANGE_SECONDS = 240;
const NOISE_RANGE_SECONDS = 90; // additional noise: -90 to +90s
const MIN_DELAY_SECONDS = 30; // absolute floor regardless of jitter/noise

/**
 * Computes how many seconds from `now` the next send through this mailbox should be scheduled.
 *
 * @param lastSentAt   The mailbox's last successful send time, or null if it has never sent.
 * @param now          The current time (injected for testability).
 * @param pendingReservationAt Absolute time of an already-reserved slot for this mailbox (Redis
 *                     reservation, prevents double-booking within the same enqueuer tick), or
 *                     null if none.
 */
export function computeNextSlotSeconds(
  lastSentAt: Date | null,
  now: Date,
  pendingReservationAt: Date | null,
): number {
  const nowMs = now.getTime();

  const cadenceFloorMs = lastSentAt ? lastSentAt.getTime() + CADENCE_FLOOR_MS : nowMs;
  let candidateMs = Math.max(nowMs, cadenceFloorMs);

  if (pendingReservationAt) {
    candidateMs = Math.max(candidateMs, pendingReservationAt.getTime());
  }

  const jitterSeconds = JITTER_BASE_SECONDS + Math.random() * JITTER_RANGE_SECONDS;
  const noiseSeconds = (Math.random() * 2 - 1) * NOISE_RANGE_SECONDS;
  candidateMs += (jitterSeconds + noiseSeconds) * 1000;

  const delaySeconds = Math.round((candidateMs - nowMs) / 1000);
  return Math.max(MIN_DELAY_SECONDS, delaySeconds);
}
