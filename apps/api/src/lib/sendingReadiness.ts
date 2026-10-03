/**
 * Can this campaign send? — the launch check, one place for every rule, so the launch route, the
 * dashboard's Launch step and the campaign list's "Can't launch yet" banner never disagree.
 *
 * Every problem comes back at once (never the first one only), each with enough detail for the
 * dashboard to name the fix: which domain has no address, which follow-up is empty. Problems block
 * launch; warnings don't.
 *
 * The worker applies the same sender rules at send time on its own (`apps/worker/src/enqueuer.ts`
 * and `processor.ts`): a mailbox that is paused, or whose domain loses its address after launch, is
 * skipped rather than sending without a footer address.
 */
import type { CampaignStatus, MailboxStatus } from '@warmhawk/db';
import { prisma } from '@warmhawk/db';

export const STANDARD_FIELDS = ['firstName', 'lastName', 'company', 'email', 'senderName'];

export function domainHasAddress(domain: { mailingAddress: string | null }): boolean {
  return Boolean(domain.mailingAddress?.trim());
}

/** `{{name}}` tokens in the given texts, de-duplicated case-insensitively (merge-field filling is
 *  case-insensitive too), keeping the first spelling seen. */
export function mergeTokens(texts: string[]): string[] {
  const seen = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
      if (!seen.has(match[1].toLowerCase())) seen.set(match[1].toLowerCase(), match[1]);
    }
  }
  return [...seen.values()];
}

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

export interface FieldLead {
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  customFields: unknown;
}

export interface FieldStatus {
  name: string;
  status: 'ok' | 'partial' | 'unknown';
  missingCount: number;
}

/** Which `{{fields}}` in the texts fill for these leads. Standard fields always resolve
 *  (`senderName` falls back to the mailbox address); a custom field is checked against the leads,
 *  with a count of leads that have it blank; a token no lead has at all is `unknown` — it would go
 *  out as literal `{{token}}` text. */
export function checkFields(
  texts: string[],
  leads: FieldLead[],
): { available: string[]; fields: FieldStatus[] } {
  const customKeys = new Map<string, string>();
  for (const lead of leads) {
    if (typeof lead.customFields !== 'object' || !lead.customFields) continue;
    for (const key of Object.keys(lead.customFields)) {
      if (!customKeys.has(key.toLowerCase())) customKeys.set(key.toLowerCase(), key);
    }
  }
  const valueOf = (lead: FieldLead, name: string): unknown => {
    const lower = name.toLowerCase();
    if (lower === 'firstname') return lead.firstName;
    if (lower === 'lastname') return lead.lastName;
    if (lower === 'company') return lead.company;
    const custom = (lead.customFields ?? {}) as Record<string, unknown>;
    const key = Object.keys(custom).find((k) => k.toLowerCase() === lower);
    return key ? custom[key] : undefined;
  };

  const fields = mergeTokens(texts).map((name): FieldStatus => {
    const lower = name.toLowerCase();
    const standard = STANDARD_FIELDS.some((field) => field.toLowerCase() === lower);
    if (!standard && !customKeys.has(lower))
      return { name, status: 'unknown', missingCount: leads.length };
    const alwaysSet = lower === 'email' || lower === 'sendername';
    const missingCount = alwaysSet
      ? 0
      : leads.filter((lead) => isBlank(valueOf(lead, name))).length;
    return { name, status: missingCount ? 'partial' : 'ok', missingCount };
  });

  return {
    available: [
      ...STANDARD_FIELDS,
      ...[...customKeys.values()].filter((key) => !STANDARD_FIELDS.includes(key)),
    ],
    fields,
  };
}

export type LaunchProblem =
  | { code: 'NO_SENDERS'; message: string }
  | {
      code: 'DOMAIN_NO_ADDRESS';
      message: string;
      domainId: string;
      domainName: string;
      mailboxCount: number;
    }
  | { code: 'NO_UNSUBSCRIBE'; message: string }
  | { code: 'BOUNCE_PAUSED'; message: string }
  | { code: 'EMAIL_EMPTY'; message: string }
  | { code: 'STEP_EMPTY'; message: string; position: number };

export type LaunchWarning =
  | { code: 'SENDER_NAME_MISSING'; message: string; mailboxes: { id: string; email: string }[] }
  | { code: 'ALL_WARMING'; message: string }
  | { code: 'NO_LEADS'; message: string }
  | { code: 'FIELD_BLANK'; message: string; field: string; missingCount: number }
  | { code: 'FIELD_UNKNOWN'; message: string; field: string };

export interface LaunchCheck {
  canLaunch: boolean;
  problems: LaunchProblem[];
  warnings: LaunchWarning[];
  /** What passed, as short codes, for the Launch step's "Passed" list. */
  passed: Array<'SENDERS' | 'ADDRESSES' | 'UNSUBSCRIBE' | 'BOUNCE' | 'COPY'>;
}

export interface ReadinessMailbox {
  id: string;
  email: string;
  status: MailboxStatus;
  senderName: string | null;
  domain: { id: string; domainName: string; mailingAddress: string | null };
}

export interface ReadinessCampaign {
  status: CampaignStatus;
  template: string | null;
  subject: string | null;
  unsubscribeUrlTemplate: string | null;
  pausedForBounceRate: boolean;
  mailboxes: ReadinessMailbox[];
  steps: { position: number; body: string }[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Pure: everything the launch check decides from already-loaded rows. `fieldLeads` is optional —
 *  the campaign list skips the per-lead merge-field scan. */
export function evaluateLaunch(
  campaign: ReadinessCampaign,
  options: { leadCount?: number; fieldLeads?: FieldLead[]; builtInUnsubscribe?: boolean } = {},
): LaunchCheck {
  const problems: LaunchProblem[] = [];
  const warnings: LaunchWarning[] = [];
  const passed: LaunchCheck['passed'] = [];

  // A paused mailbox can't send; a warming one joins once warm-up finishes.
  const usable = campaign.mailboxes.filter((m) => m.status !== 'PAUSED');
  if (usable.length === 0) {
    problems.push({
      code: 'NO_SENDERS',
      message:
        campaign.mailboxes.length === 0
          ? 'Pick at least one mailbox to send from'
          : 'Every mailbox this campaign sends from is paused',
    });
  } else {
    passed.push('SENDERS');
    if (usable.every((m) => m.status === 'WARMUP')) {
      warnings.push({
        code: 'ALL_WARMING',
        message:
          'Every mailbox is still warming up — first emails start when the first one finishes',
      });
    }
  }

  const byDomain = new Map<string, { domain: ReadinessMailbox['domain']; count: number }>();
  for (const m of usable) {
    const entry = byDomain.get(m.domain.id) ?? { domain: m.domain, count: 0 };
    entry.count += 1;
    byDomain.set(m.domain.id, entry);
  }
  const missingAddress = [...byDomain.values()].filter((d) => !domainHasAddress(d.domain));
  for (const { domain, count } of missingAddress) {
    problems.push({
      code: 'DOMAIN_NO_ADDRESS',
      message: `${domain.domainName} has no mailing address`,
      domainId: domain.id,
      domainName: domain.domainName,
      mailboxCount: count,
    });
  }
  if (usable.length > 0 && missingAddress.length === 0) passed.push('ADDRESSES');

  if (!campaign.unsubscribeUrlTemplate?.trim() && !options.builtInUnsubscribe) {
    problems.push({
      code: 'NO_UNSUBSCRIBE',
      message: 'Add an unsubscribe link — this install has no public address for the built-in page',
    });
  } else {
    passed.push('UNSUBSCRIBE');
  }

  if (campaign.pausedForBounceRate) {
    problems.push({
      code: 'BOUNCE_PAUSED',
      message: 'Paused for a high bounce rate — clean the list, then resume',
    });
  } else {
    passed.push('BOUNCE');
  }

  const emptyBefore = problems.length;
  if (!campaign.template?.trim()) {
    problems.push({
      code: 'EMAIL_EMPTY',
      message: 'Email 1 has no text — it is what sends when AI is off or fails',
    });
  }
  for (const step of [...campaign.steps].sort((a, b) => a.position - b.position)) {
    if (!step.body.trim()) {
      problems.push({
        code: 'STEP_EMPTY',
        message: `Follow-up ${step.position} needs backup text`,
        position: step.position,
      });
    }
  }
  if (problems.length === emptyBefore) passed.push('COPY');

  const unnamed = usable.filter((m) => !m.senderName?.trim());
  if (unnamed.length > 0) {
    warnings.push({
      code: 'SENDER_NAME_MISSING',
      message: `${plural(unnamed.length, 'mailbox', 'mailboxes')} ${unnamed.length === 1 ? 'has' : 'have'} no sender name — the address shows instead`,
      mailboxes: unnamed.map((m) => ({ id: m.id, email: m.email })),
    });
  }

  if (options.leadCount === 0) {
    warnings.push({
      code: 'NO_LEADS',
      message: 'No leads yet — the campaign launches but has no one to email',
    });
  }

  if (options.fieldLeads && options.fieldLeads.length > 0) {
    const texts = [
      campaign.subject ?? '',
      campaign.template ?? '',
      ...campaign.steps.map((s) => s.body),
    ];
    for (const field of checkFields(texts, options.fieldLeads).fields) {
      if (field.status === 'unknown') {
        warnings.push({
          code: 'FIELD_UNKNOWN',
          message: `{{${field.name}}} isn't a column in your leads — it would go out as written`,
          field: field.name,
        });
      } else if (field.status === 'partial') {
        warnings.push({
          code: 'FIELD_BLANK',
          message: `{{${field.name}}} is empty for ${plural(field.missingCount, 'lead')}`,
          field: field.name,
          missingCount: field.missingCount,
        });
      }
    }
  }

  return { canLaunch: problems.length === 0, problems, warnings, passed };
}

export const readinessInclude = {
  mailboxes: {
    include: {
      mailbox: {
        select: {
          id: true,
          email: true,
          status: true,
          senderName: true,
          domain: { select: { id: true, domainName: true, mailingAddress: true } },
        },
      },
    },
  },
  steps: { orderBy: { position: 'asc' as const } },
} as const;

/** The built-in unsubscribe page needs a public domain to link to (`routes/unsubscribe.ts`). */
export function builtInUnsubscribeAvailable(): boolean {
  return Boolean(process.env.WARMHAWK_DOMAIN?.trim());
}

/** Loads a campaign and runs the full launch check, including the merge-field scan. */
export async function checkCampaignLaunch(campaignId: string): Promise<LaunchCheck | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: readinessInclude,
  });
  if (!campaign) return null;
  const [leadCount, fieldLeads] = await Promise.all([
    prisma.lead.count({ where: { campaignId } }),
    prisma.lead.findMany({
      where: {
        campaignId,
        piiErasedAt: null,
        status: { in: ['UNTOUCHED', 'QUEUED', 'CONTACTED', 'OPENED'] },
      },
      select: { firstName: true, lastName: true, company: true, customFields: true },
      take: 5_000,
    }),
  ]);
  return evaluateLaunch(
    { ...campaign, mailboxes: campaign.mailboxes.map((link) => link.mailbox) },
    { leadCount, fieldLeads, builtInUnsubscribe: builtInUnsubscribeAvailable() },
  );
}
