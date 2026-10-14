/**
 * Cadence/jitter math — addresses Competitor Pain Points #12: "Lemlist pushes unsafe daily send
 * volumes on new domains" by enforcing an 8-min cadence floor + jitter. Pure function, no I/O,
 * fully unit-testable.
 *
 * Send schedule (10-14-26): with a send window, the enqueuer also passes `spreadMs` — the time
 * left in the window divided by the sends the mailbox has left — so a day's sends spread across
 * the window instead of bunching at its start. The 8-minute floor still applies on top.
 */
const CADENCE_FLOOR_MS = 8 * 60 * 1000; // 8-minute floor since this mailbox's last send
const JITTER_BASE_SECONDS = 240; // jitter band: 240-480s
const JITTER_RANGE_SECONDS = 240;
const NOISE_RANGE_SECONDS = 90; // additional noise: -90 to +90s
const MIN_DELAY_SECONDS = 30; // absolute floor regardless of jitter/noise
/** A spread gap varies ±20% around its target, so sends never land on a fixed beat. */
const SPREAD_VARIANCE = 0.2;

/**
 * Computes how many seconds from `now` the next send through this mailbox should be scheduled.
 *
 * @param lastSentAt   The mailbox's last successful send time, or null if it has never sent.
 * @param now          The current time (injected for testability).
 * @param pendingReservationAt Absolute time of an already-reserved slot for this mailbox (Redis
 *                     reservation, prevents double-booking), or null if none. The next slot keeps
 *                     the same floor after it as after a real send.
 * @param spreadMs     The target gap between this mailbox's sends, from the send window; 0 = none
 *                     (no schedule — send as the floor and jitter allow).
 */
export function computeNextSlotSeconds(
  lastSentAt: Date | null,
  now: Date,
  pendingReservationAt: Date | null,
  spreadMs = 0,
): number {
  const nowMs = now.getTime();

  // The latest of the last real send and the slot already booked — the next one follows it.
  const anchorMs = Math.max(
    lastSentAt?.getTime() ?? -Infinity,
    pendingReservationAt?.getTime() ?? -Infinity,
  );
  const hasAnchor = Number.isFinite(anchorMs);

  let candidateMs = hasAnchor ? Math.max(nowMs, anchorMs + CADENCE_FLOOR_MS) : nowMs;

  const jitterSeconds = JITTER_BASE_SECONDS + Math.random() * JITTER_RANGE_SECONDS;
  const noiseSeconds = (Math.random() * 2 - 1) * NOISE_RANGE_SECONDS;
  candidateMs += (jitterSeconds + noiseSeconds) * 1000;

  if (hasAnchor && spreadMs > 0) {
    const spreadGapMs = spreadMs * (1 - SPREAD_VARIANCE + Math.random() * 2 * SPREAD_VARIANCE);
    candidateMs = Math.max(candidateMs, anchorMs + spreadGapMs);
  }

  const delaySeconds = Math.round((candidateMs - nowMs) / 1000);
  return Math.max(MIN_DELAY_SECONDS, delaySeconds);
}
