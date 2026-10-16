/**
 * The day someone says they're back, read from an out-of-office reply ("I'm out until October 20",
 * "back on 10/21", "returning Monday"). Pure text parsing: no AI call, so it works on an install
 * with no AI key, and the same reply always gives the same day.
 *
 * Every date the reply mentions that falls on or after the day it arrived (and not absurdly far
 * out) is a candidate; the latest one wins, because an away notice names its last day or its
 * return day after any other date in it ("out Oct 15 to Oct 20, back Oct 21"). Returns that day at
 * 00:00 UTC, or null when the reply names no usable date.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A date further out than this is more likely a misread (a year, a ticket number) than a leave. */
export const MAX_AWAY_DAYS = 90;

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR = '(?:,?\\s*(\\d{4}))?';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function utcDay(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** A date written without a year is the next one on or after the reply's day. */
function withYear(month: number, day: number, year: string | undefined, from: Date): Date | null {
  if (year) return utcDay(Number(year), month, day);
  const sameYear = utcDay(from.getUTCFullYear(), month, day);
  if (sameYear && sameYear >= from) return sameYear;
  return utcDay(from.getUTCFullYear() + 1, month, day);
}

export function parseReturnDate(text: string, receivedAt: Date): Date | null {
  const lower = text.toLowerCase();
  const from = startOfUtcDay(receivedAt);
  const found: Date[] = [];
  const add = (date: Date | null) => {
    if (date) found.push(date);
  };

  // 2026-10-20
  for (const m of lower.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    add(utcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  // October 20, 2026 · Oct 20th · Oct. 15-20 (the range's end counts too)
  for (const m of lower.matchAll(
    new RegExp(`\\b${MONTH}\\s+${DAY}(?:\\s*(?:-|–|to|through|thru)\\s*${DAY})?${YEAR}`, 'g'),
  )) {
    const month = MONTHS[m[1]!.slice(0, m[1]!.startsWith('sept') ? 4 : 3)]!;
    add(withYear(month, Number(m[2]), m[4], from));
    if (m[3]) add(withYear(month, Number(m[3]), m[4], from));
  }
  // 20 October 2026 · 20th of Oct
  for (const m of lower.matchAll(new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}${YEAR}`, 'g'))) {
    const month = MONTHS[m[2]!.slice(0, m[2]!.startsWith('sept') ? 4 : 3)]!;
    add(withYear(month, Number(m[1]), m[3], from));
  }
  // 10/20/2026 · 10/20 · 20/10/2026 (day first when the first number can't be a month). Slashes
  // only: "9.30" is more often a time than a date.
  for (const m of lower.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g)) {
    let [month, day] = [Number(m[1]), Number(m[2])];
    if (month > 12 && day <= 12) [month, day] = [day, month];
    const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : undefined;
    add(withYear(month - 1, day, year, from));
  }
  // "back Monday" / "returning on Tuesday": the next such day after the reply.
  for (const m of lower.matchAll(
    /\b(?:back|return(?:ing)?|in the office|resum(?:e|ing))\b[^.\n]{0,20}?\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g,
  )) {
    const target = WEEKDAYS.indexOf(m[1]!);
    const ahead = (target - from.getUTCDay() + 7) % 7 || 7;
    add(new Date(from.getTime() + ahead * DAY_MS));
  }
  if (/\b(?:back|return(?:ing)?)\s+tomorrow\b/.test(lower)) {
    add(new Date(from.getTime() + DAY_MS));
  }

  const latest = new Date(from.getTime() + MAX_AWAY_DAYS * DAY_MS);
  const usable = found.filter((date) => date >= from && date <= latest);
  if (usable.length === 0) return null;
  return new Date(Math.max(...usable.map((date) => date.getTime())));
}
