/**
 * WarmHawk Core Engine — root shared constants (pagination, warmup tiers, dev fallback URLs),
 * extended per the V12 spec with `MAX_CSV_ROWS` / `MAX_CSV_FILE_BYTES` (Phase 2, CSV import caps).
 */

// --- Pagination
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

// --- Time
export const MS_PER_DAY = 86_400_000;

// --- Dev-only fallbacks (local dev / docker-compose defaults, never production values)
export const DEV_API_BASE_URL = 'http://localhost:4600';
export const DEV_N8N_BASE_URL = 'http://localhost:4605';

// --- Mailbox warmup ramp (mirrors the n8n warmup workflow's tier curve)
const WARMUP_TIERS = [
  { maxDay: 3, cap: 3 },
  { maxDay: 7, cap: 8 },
  { maxDay: 14, cap: 15 },
] as const;
const WARMUP_TIER_CAP_BEYOND = 25;

export function warmupTierCapFor(warmupDay: number): number {
  for (const tier of WARMUP_TIERS) {
    if (warmupDay <= tier.maxDay) return tier.cap;
  }
  return WARMUP_TIER_CAP_BEYOND;
}

// --- CSV import (new, V12/Phase 2 — POST /leads/import)
/** Hard cap on the number of data rows accepted in a single CSV import — protects the API
 *  process and the chunked `prisma.lead.createMany` batch-insert from an unbounded file. */
export const MAX_CSV_ROWS = 50_000;
/** Hard cap on the uploaded CSV file's raw byte size (10 MiB) — enforced by multer's `limits`
 *  option before the file is even parsed. */
export const MAX_CSV_FILE_BYTES = 10 * 1024 * 1024;

// --- Rate limiting (Guardrails — every public-facing endpoint)
export const RATE_LIMIT_WEBHOOK_INGEST = { max: 30, timeWindowMs: 60_000 };
export const RATE_LIMIT_CSV_IMPORT = { max: 10, timeWindowMs: 60_000 };
export const RATE_LIMIT_PUBLIC_DOMAIN_CHECK = { max: 20, timeWindowMs: 60_000 };
export const RATE_LIMIT_LOGIN = { max: 10, timeWindowMs: 60_000 };

// --- Bounce/complaint circuit breaker (Guardrails — Reputation protection)
export const DEFAULT_BOUNCE_RATE_THRESHOLD = 0.05; // 5%
export const BOUNCE_RATE_MIN_SAMPLE_SIZE = 20; // don't trip the breaker on tiny send counts

// --- Login brute-force protection (Guardrails — Account security)
export const LOGIN_MAX_FAILED_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// --- Backup retention (Backups & Disaster Recovery)
export const DEFAULT_BACKUP_RETENTION_DAYS = 14;
