/**
 * Shared lead-ingest validation rules (email format, blocked-domain rejection, suppression-list
 * lookup, duplicate lookup), factored into ONE function per the V12 spec so both
 * `POST /webhooks/leads` and the new `POST /leads/import` CSV route share identical validation
 * instead of two independently-drifting copies. CSV injection defense (Guardrails) is folded in
 * here too, since both ingest paths accept arbitrary `customFields`.
 */
import { prisma } from '@warmhawk/db';
import { findCsvInjectionInRow } from './csvInjection';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Obviously-disposable/test domains rejected outright. A real deployment may extend this via
 *  env/config in a future iteration, but the baseline list ships as a constant. */
export const BLOCKED_EMAIL_DOMAINS = [
  'mailinator.com',
  'tempmail.com',
  'guerrillamail.com',
  'example.com',
];

export interface RawLeadInput {
  campaignId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  customFields?: Record<string, unknown>;
}

export interface NormalizedLead {
  campaignId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  customFields: Record<string, unknown>;
}

export type LeadRejectionReason =
  'missing_campaign_id' | 'invalid_email' | 'blocked_domain' | 'csv_injection_risk';

export type LeadFieldValidationResult =
  | { valid: true; lead: NormalizedLead }
  | { valid: false; reason: LeadRejectionReason; detail?: string };

/** Normalizes + validates the FORMAT of a single lead row — no I/O, pure and unit-testable.
 *  Does not check suppression/duplicate status (those require a DB round-trip — see
 *  `isEmailSuppressed`/`isDuplicateLead`, called separately by the route after this passes). */
export function validateLeadFields(input: RawLeadInput): LeadFieldValidationResult {
  const campaignId = input.campaignId?.trim();
  if (!campaignId) {
    return { valid: false, reason: 'missing_campaign_id' };
  }

  const email = input.email?.trim().toLowerCase() ?? '';
  if (!EMAIL_REGEX.test(email)) {
    return { valid: false, reason: 'invalid_email' };
  }

  const domain = email.split('@')[1] ?? '';
  if (BLOCKED_EMAIL_DOMAINS.includes(domain)) {
    return { valid: false, reason: 'blocked_domain' };
  }

  const firstName = input.firstName?.trim() || null;
  const lastName = input.lastName?.trim() || null;
  const company = input.company?.trim() || null;
  const customFields = input.customFields ?? {};

  const injectionCheck = findCsvInjectionInRow({
    firstName: firstName ?? '',
    lastName: lastName ?? '',
    company: company ?? '',
    ...customFields,
  });
  if (injectionCheck) {
    return {
      valid: false,
      reason: 'csv_injection_risk',
      detail: `Field "${injectionCheck.field}": ${injectionCheck.reason}`,
    };
  }

  return {
    valid: true,
    lead: { campaignId, email, firstName, lastName, company, customFields },
  };
}

/** Suppression-list check — the hard floor (Guardrails: "no code path anywhere may re-add or
 *  bypass a suppressed email"). Both webhook ingest and CSV import call this before insert;
 *  never re-add on top of it. */
export async function isEmailSuppressed(email: string): Promise<boolean> {
  const entry = await prisma.suppressionEntry.findUnique({ where: { email } });
  return entry !== null;
}

/** Per-campaign duplicate check (also enforced at the DB level via the
 *  `@@unique([campaignId, email])` constraint — this is the pre-check so the route can respond
 *  with a "skipped: duplicate" reason instead of surfacing a raw constraint-violation error). */
export async function isDuplicateLead(campaignId: string, email: string): Promise<boolean> {
  const existing = await prisma.lead.findUnique({
    where: { campaignId_email: { campaignId, email } },
  });
  return existing !== null;
}
