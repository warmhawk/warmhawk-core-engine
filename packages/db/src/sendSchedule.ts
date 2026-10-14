/**
 * Campaign send schedule (10-14-26) — the days and hours a campaign's emails go out, in an IANA
 * time zone. Pure date math on `Intl`, no I/O, so the worker (which enforces it) and the API (which
 * validates it and reports when a campaign sends next) share one copy. Daylight-saving changes are
 * handled by resolving each local day's start and end against the zone's offset on that day.
 *
 * A campaign without a schedule (`sendTimezone` null — every campaign from before this existed)
 * is always open, which is exactly how it sent before.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MINUTES_PER_DAY = 24 * 60;

export interface SendSchedule {
  /** IANA zone the window is read in, e.g. "America/Chicago". */
  timezone: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Minutes after local midnight, start < end, end ≤ 1440. */
  startMinute: number;
  endMinute: number;
}

export interface CampaignScheduleFields {
  sendTimezone: string | null;
  sendDays: number[];
  sendStartMinute: number | null;
  sendEndMinute: number | null;
}

export interface WindowState {
  open: boolean;
  /** When open, ms until this window closes; Infinity with no schedule; 0 when closed. */
  msLeft: number;
  /** When open, when this window closes; null otherwise or with no schedule. */
  closesAt: Date | null;
  /** When closed, when the next window opens; null when open or no day is ticked. */
  nextOpenAt: Date | null;
}

const ALWAYS_OPEN: WindowState = { open: true, msLeft: Infinity, closesAt: null, nextOpenAt: null };

/** The schedule a campaign row describes, or null when it has none (sends any time). */
export function campaignSchedule(campaign: CampaignScheduleFields): SendSchedule | null {
  if (!campaign.sendTimezone) return null;
  if (campaign.sendStartMinute == null || campaign.sendEndMinute == null) return null;
  return {
    timezone: campaign.sendTimezone,
    days: campaign.sendDays,
    startMinute: campaign.sendStartMinute,
    endMinute: campaign.sendEndMinute,
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/** True when `timezone` is a zone this runtime knows ("America/Chicago", "UTC"). */
export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || !timezone.trim() || timezone.length > 64) return false;
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Minutes after local midnight. */
  minute: number;
}

/** The wall-clock date and time at `at` in `timezone`. */
export function localParts(timezone: string, at: Date): LocalParts {
  const parts = formatterFor(timezone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year,
    month,
    day,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minute: get('hour') * 60 + get('minute'),
  };
}

/** How far `timezone`'s wall clock is ahead of UTC at `atMs`, in ms. */
function offsetMs(timezone: string, atMs: number): number {
  const parts = formatterFor(timezone).formatToParts(new Date(atMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

/** The instant a local wall-clock time happens in `timezone`. `minute` may be 1440 (the next
 *  midnight). A time skipped by a spring-forward lands just after the gap. */
export function zonedInstant(
  timezone: string,
  year: number,
  month: number,
  day: number,
  minute: number,
): Date {
  const wallMs = Date.UTC(year, month - 1, day, 0, minute);
  let guess = wallMs - offsetMs(timezone, wallMs);
  // A second pass settles the offset when the first guess fell across a DST change.
  guess = wallMs - offsetMs(timezone, guess);
  return new Date(guess);
}

/**
 * Whether `schedule` is open at `now`, read in `timezone` (the schedule's own zone by default, or
 * a lead's), and when it closes or next opens. Null schedule = always open.
 */
export function windowState(
  schedule: SendSchedule | null,
  now: Date,
  timezone: string = schedule?.timezone ?? 'UTC',
): WindowState {
  if (!schedule) return ALWAYS_OPEN;
  const zone = isValidTimezone(timezone) ? timezone : schedule.timezone;
  const days = new Set(schedule.days);
  if (days.size === 0) return { open: false, msLeft: 0, closesAt: null, nextOpenAt: null };

  const today = localParts(zone, now);
  // Walk local calendar days from today; a week ahead always reaches a ticked day.
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = date.getUTCDay();
    if (!days.has(weekday)) continue;
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const opensAt = zonedInstant(zone, y, m, d, schedule.startMinute);
    const closesAt = zonedInstant(zone, y, m, d, schedule.endMinute);
    if (now.getTime() >= closesAt.getTime()) continue;
    if (now.getTime() >= opensAt.getTime()) {
      return { open: true, msLeft: closesAt.getTime() - now.getTime(), closesAt, nextOpenAt: null };
    }
    return { open: false, msLeft: 0, closesAt: null, nextOpenAt: opensAt };
  }
  return { open: false, msLeft: 0, closesAt: null, nextOpenAt: null };
}

/**
 * Validates a schedule as the API receives it. Returns an error message, or null when valid.
 * `sendTimezone: null` (no schedule) is always valid; otherwise every part must be present.
 */
export function scheduleError(fields: {
  sendTimezone: unknown;
  sendDays: unknown;
  sendStartMinute: unknown;
  sendEndMinute: unknown;
}): string | null {
  if (fields.sendTimezone === null) return null;
  if (!isValidTimezone(fields.sendTimezone)) return 'sendTimezone must be an IANA time zone';
  const days = fields.sendDays;
  if (
    !Array.isArray(days) ||
    days.length === 0 ||
    days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
    new Set(days).size !== days.length
  ) {
    return 'sendDays must list at least one day, 0 (Sunday) to 6 (Saturday)';
  }
  const { sendStartMinute: start, sendEndMinute: end } = fields;
  if (!Number.isInteger(start) || (start as number) < 0 || (start as number) >= MINUTES_PER_DAY) {
    return 'sendStartMinute must be a whole number of minutes, 0 to 1439';
  }
  if (!Number.isInteger(end) || (end as number) < 1 || (end as number) > MINUTES_PER_DAY) {
    return 'sendEndMinute must be a whole number of minutes, 1 to 1440';
  }
  if ((end as number) <= (start as number)) return 'The send window must end after it starts';
  return null;
}
