/**
 * Page-number pagination shared by the dashboard's list routes (leads, replies, warmup send log).
 *
 * `?page=` is 1-based and `?pageSize=` is capped at `MAX_PAGE_SIZE`. Page-number paging (not a
 * cursor) is deliberate: each list is filtered to one instance's own data, stays in the tens of
 * thousands of rows at most, and the dashboard shows "26–50 of 312" with Prev / Next.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface PageQuery {
  page?: string;
  pageSize?: string;
}

export interface Page {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export type PageParseResult = { ok: true; value: Page } | { ok: false; error: string };

function positiveInt(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/** True when the caller asked for a page — lets a route keep its older unpaged response shape
 *  for dashboards that predate paging. */
export function wantsPage(query: PageQuery): boolean {
  return query.page !== undefined || query.pageSize !== undefined;
}

export function parsePage(query: PageQuery, defaultPageSize = DEFAULT_PAGE_SIZE): PageParseResult {
  const page = positiveInt(query.page);
  const pageSize = positiveInt(query.pageSize);
  if (page === null) return { ok: false, error: 'page must be a whole number of 1 or more' };
  if (pageSize === null) return { ok: false, error: 'pageSize must be a whole number of 1 or more' };
  const size = Math.min(pageSize ?? defaultPageSize, MAX_PAGE_SIZE);
  const current = page ?? 1;
  return { ok: true, value: { page: current, pageSize: size, skip: (current - 1) * size, take: size } };
}

/** Validates an optional enum-like query value; `undefined`/empty means "no filter". */
export function parseChoice<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  name: string,
): { ok: true; value: T | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === '') return { ok: true, value: undefined };
  if ((allowed as readonly string[]).includes(raw)) return { ok: true, value: raw as T };
  return { ok: false, error: `${name} must be one of: ${allowed.join(', ')}` };
}
