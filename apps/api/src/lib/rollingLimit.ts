/**
 * The worker's daily limit as the Live Queue reads it (10-16-26). The enqueuer counts a mailbox's
 * sends over a rolling 24 hours (`apps/worker/src/rollingSends.ts`), not per UTC day, so a mailbox
 * that sent late yesterday can be at its limit this morning with only one email out today. The
 * Live Queue said "+5 expected" with nothing booked and no reason why.
 *
 *   - `stillCounted`: the sends that still count against the limit at a given moment, such as the
 *     window's close: today's room is the cap less those (the same sum `spreadGapMs` makes).
 *   - `limitFreesAt`: when a mailbox at its limit can book again, as its oldest counted send
 *     turns a day old.
 *
 * Pure; no I/O.
 */
import { localParts, zonedInstant, DAY_MS, type SendSchedule } from '@warmhawk/db';

/** The sends in `sendTimesMs` still inside the 24 hours before `atMs`. */
export function stillCounted(sendTimesMs: number[], atMs: number): number {
  return sendTimesMs.filter((t) => t > atMs - DAY_MS).length;
}

/**
 * When a mailbox at its limit has room again: the moment enough of its last 24 hours' sends are a
 * day old to leave one free. Null when it has room now, or a cap of 0 that no wait frees.
 */
export function limitFreesAt(sendTimesMs: number[], cap: number, nowMs: number): number | null {
  if (cap <= 0) return null;
  const counted = sendTimesMs.filter((t) => t > nowMs - DAY_MS).sort((a, b) => a - b);
  if (counted.length < cap) return null;
  return counted[counted.length - cap]! + DAY_MS;
}

/** When a campaign's send window closes today, in its own zone; the end of the UTC day with no
 *  schedule. Only meaningful on a day it sends. */
export function closesTodayMs(schedule: SendSchedule | null, now: Date): number {
  if (!schedule) {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS;
  }
  const { year, month, day } = localParts(schedule.timezone, now);
  return zonedInstant(schedule.timezone, year, month, day, schedule.endMinute).getTime();
}
