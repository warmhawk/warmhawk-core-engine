/**
 * CSV injection ("formula injection") defense — Guardrails / Platform-abuse protection.
 *
 * A malicious cell value beginning with `=`, `+`, `-`, or `@` can be interpreted as a formula by
 * Excel/Google Sheets when a customer later exports lead data and opens it — e.g. a lead's
 * `company` field of `=cmd|'/c calc'!A1` or a DDE-based payload. WarmHawk neutralizes this on
 * ingest (both `POST /leads/import` and the webhook path, via the shared `leadIngest.ts`
 * validation function) rather than trying to sanitize on export, so the defense holds regardless
 * of what downstream tool a customer eventually opens the data in.
 */

const DANGEROUS_LEADING_CHARS = ['=', '+', '-', '@'];

/** Returns true if `value` would be interpreted as a formula by a spreadsheet application when
 *  the CSV is opened (i.e. starts with `=`, `+`, `-`, or `@`, ignoring leading whitespace). */
export function isCsvInjectionRisk(value: string): boolean {
  const trimmed = value.trimStart();
  if (trimmed.length === 0) return false;
  return DANGEROUS_LEADING_CHARS.includes(trimmed[0]);
}

/** Neutralizes a potentially dangerous cell value by prefixing it with a single quote, the
 *  standard mitigation that forces spreadsheet applications to treat the cell as literal text
 *  instead of a formula, while preserving the original (human-visible) content. */
export function neutralizeCsvValue(value: string): string {
  if (isCsvInjectionRisk(value)) {
    return `'${value}`;
  }
  return value;
}

export type CsvFieldPolicy = 'reject' | 'neutralize';

export interface CsvInjectionCheckResult {
  safe: boolean;
  /** Present when `safe` is false and policy is 'reject'. */
  reason?: string;
  /** The value to actually store — neutralized if policy is 'neutralize', unchanged otherwise. */
  value: string;
}

/** Applies the configured policy to a single field value. `POST /leads/import` uses `'reject'`
 *  for the row (surfaced in the response's `rejected: [{ row, reason }]` array) per the Phase 2
 *  spec; `'neutralize'` is available for callers that would rather sanitize than drop a row. */
export function checkCsvField(
  value: string,
  policy: CsvFieldPolicy = 'reject',
): CsvInjectionCheckResult {
  if (!isCsvInjectionRisk(value)) {
    return { safe: true, value };
  }
  if (policy === 'neutralize') {
    return { safe: true, value: neutralizeCsvValue(value) };
  }
  return {
    safe: false,
    reason: `Field value starts with a formula-injection character (=, +, -, @): "${value.slice(0, 40)}"`,
    value,
  };
}

/** Checks every string value in a flat record (e.g. a parsed CSV row's fields, including
 *  `customFields`) and returns the first offending field name + reason, or null if the whole
 *  row is safe. Used by `leadIngest.ts` to reject a row in one pass rather than field-by-field. */
export function findCsvInjectionInRow(
  row: Record<string, unknown>,
): { field: string; reason: string } | null {
  for (const [field, value] of Object.entries(row)) {
    if (typeof value !== 'string') continue;
    const result = checkCsvField(value, 'reject');
    if (!result.safe) {
      return { field, reason: result.reason! };
    }
  }
  return null;
}
