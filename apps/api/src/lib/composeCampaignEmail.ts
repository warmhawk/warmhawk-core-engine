/**
 * One campaign email for one lead — subject and body, and who wrote them. Shared by the send path
 * (`POST /internal/ai/personalize`, called from n8n's dispatch workflow) and the dashboard's
 * preview (`POST /v1/campaigns/preview`), so what a customer previews is exactly what sends.
 *
 * The campaign's own email (`template`, `subject`) is always rendered first: it is what goes out
 * with no provider, and what goes out when the provider fails. With a provider, PERSONALIZE mode
 * hands that rendered email to the model to adjust; PROMPT mode has the model write from the
 * instructions alone. Every send reports an `aiOutcome` and, on a fall-back, a reason — so a
 * retired model or a removed key shows up as a count on the dashboard instead of silently turning
 * every send into the plain template.
 */
import type { AiProvider, AiWriteOutcome, CampaignAiMode } from '@warmhawk/db';
import { prisma } from '@warmhawk/db';
import { decrypt, loadEncryptionKey } from './encryption';
import {
  personalizeContent,
  fillMergeFields,
  parseGeneratedEmail,
  classifyAiFailure,
  type AiFallbackReason,
  type PersonalizeRequest,
} from './aiProviderClient';
import { renderSpintax } from './spintax';
import { appendEuAiDisclosureIfNeeded } from './sendCompliance';

const PERSONALIZATION_RETRY_DELAY_MS = 1_500;
export const FALLBACK_SUBJECT = 'Quick question';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-once-then-fall-back policy (resolved when real AI calls were wired in): a flaky provider
 *  must never stall a send. One retry after a short delay absorbs a transient blip; a second
 *  failure falls back to the campaign's own template so the send still goes out, un-personalized,
 *  rather than the queue stalling on it. `aiPersonalizationFailed: true` on the response is the
 *  visible flag callers key off of, and `aiFallbackReason` says why. */
export async function personalizeWithFallback(
  request: PersonalizeRequest,
  fallbackText: string,
): Promise<{
  generatedText: string;
  aiUsed: boolean;
  aiPersonalizationFailed: boolean;
  aiFallbackReason: AiFallbackReason | null;
}> {
  try {
    const { generatedText } = await personalizeContent(request);
    return { generatedText, aiUsed: true, aiPersonalizationFailed: false, aiFallbackReason: null };
  } catch {
    await sleep(PERSONALIZATION_RETRY_DELAY_MS);
    try {
      const { generatedText } = await personalizeContent(request);
      return { generatedText, aiUsed: true, aiPersonalizationFailed: false, aiFallbackReason: null };
    } catch (err) {
      return {
        generatedText: fallbackText,
        aiUsed: false,
        aiPersonalizationFailed: true,
        aiFallbackReason: classifyAiFailure(err),
      };
    }
  }
}

/** Renders the campaign's own literal template for the no-AI-provider / inactive-key fallback
 *  path: merge fields first, then spintax. `{{firstName}}` is itself a balanced `{...}` pair one
 *  level in (`{firstName}`) — `lib/spintax.ts`'s innermost-group regex explicitly excludes that
 *  doubled-brace shape (see its own comment, bug fix 2026-09-04), so `renderSpintax` alone no
 *  longer corrupts an unfilled merge field even if this ran out of order. Filling merge fields
 *  first is kept anyway, both because it's the more obviously correct order and as defense in
 *  depth: it removes every `{{...}}` pair before spintax's regex runs at all, rather than relying
 *  solely on that regex's exclusion. */
export function renderFallbackTemplate(template: string, leadContext: Record<string, unknown>): string {
  const merged = fillMergeFields(template, leadContext);
  return renderSpintax(merged);
}

/** The From display name and `{{senderName}}`: the mailbox's own sender name, else the address's
 *  local part tidied into a first name (`dana.reyes@` → `Dana`) so the merge field never goes out
 *  as literal `{{senderName}}`. */
export function resolveSenderName(mailbox: { email: string; senderName: string | null } | null): string | null {
  if (!mailbox) return null;
  if (mailbox.senderName?.trim()) return mailbox.senderName.trim();
  const first = mailbox.email.split('@')[0]?.split(/[._+-]/)[0] ?? '';
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : null;
}

export function buildLeadContext(
  lead: { email: string; firstName: string | null; lastName: string | null; company: string | null; customFields: unknown },
  senderName: string | null,
): Record<string, unknown> {
  return {
    firstName: lead.firstName,
    lastName: lead.lastName,
    company: lead.company,
    email: lead.email,
    ...(senderName ? { senderName } : {}),
    ...(typeof lead.customFields === 'object' && lead.customFields ? (lead.customFields as object) : {}),
  };
}

/** The pre-subject-field rule, kept for campaigns with no subject: a short first line becomes the
 *  subject and is taken off the body. Same split n8n's dispatch workflow used to do itself. */
export function splitLegacySubject(text: string): { subject: string; body: string } {
  const firstNewline = text.indexOf('\n');
  if (firstNewline > 0 && firstNewline < 120) {
    const subject = text.slice(0, firstNewline).trim();
    const body = text.slice(firstNewline + 1).trim();
    if (subject && body) return { subject, body };
  }
  return { subject: FALLBACK_SUBJECT, body: text.trim() };
}

export interface ComposeCampaign {
  template: string | null;
  subject: string | null;
  aiPromptTemplate: string;
  aiProvider: AiProvider | null;
  aiMode: CampaignAiMode;
  aiWritesSubject: boolean;
}

export interface ComposeLead {
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  customFields: unknown;
}

export interface ComposedEmail {
  subject: string;
  body: string;
  aiOutcome: AiWriteOutcome;
  aiFallbackReason: AiFallbackReason | null;
  euAiDisclosureAppended: boolean;
  /** What this lead gets if the provider fails — the campaign's own email, rendered. */
  fallback: { subject: string; body: string };
}

function renderOwnEmail(campaign: ComposeCampaign, leadContext: Record<string, unknown>) {
  const body = renderFallbackTemplate(campaign.template ?? campaign.aiPromptTemplate, leadContext);
  const subject = campaign.subject?.trim() ? renderFallbackTemplate(campaign.subject, leadContext).trim() : '';
  return subject ? { subject, body: body.trim() } : splitLegacySubject(body);
}

function countryCodeOf(lead: ComposeLead): string | undefined {
  return typeof lead.customFields === 'object' && lead.customFields
    ? ((lead.customFields as Record<string, unknown>).countryCode as string | undefined)
    : undefined;
}

export async function composeCampaignEmail(params: {
  campaign: ComposeCampaign;
  lead: ComposeLead;
  senderName: string | null;
}): Promise<ComposedEmail> {
  const { campaign, lead, senderName } = params;
  const leadContext = buildLeadContext(lead, senderName);
  const own = renderOwnEmail(campaign, leadContext);
  const plain = (aiOutcome: AiWriteOutcome, aiFallbackReason: AiFallbackReason | null): ComposedEmail => ({
    ...own,
    aiOutcome,
    aiFallbackReason,
    euAiDisclosureAppended: false,
    fallback: own,
  });

  if (!campaign.aiProvider) return plain('TEMPLATE', null);

  const providerKey = await prisma.aiProviderKey.findUnique({ where: { provider: campaign.aiProvider } });
  if (!providerKey || !providerKey.isActive) return plain('AI_FALLBACK', 'key_missing');

  // A campaign with no subject of its own has the model write one rather than send its first line.
  const wantsSubject = campaign.aiWritesSubject || !campaign.subject?.trim();
  const ownBody = renderFallbackTemplate(campaign.template ?? '', leadContext).trim();
  const apiKey = decrypt(providerKey.apiKeyEncrypted, loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || ''));
  const result = await personalizeWithFallback(
    {
      provider: campaign.aiProvider,
      apiKey,
      model: providerKey.model,
      promptTemplate: campaign.aiPromptTemplate,
      leadContext,
      mode: campaign.aiMode,
      baseEmail: ownBody,
      wantsSubject,
    },
    '',
  );
  if (!result.aiUsed) return plain('AI_FALLBACK', result.aiFallbackReason);

  // Subject precedence: the model's when the campaign asked for it, else the campaign's own, else
  // the model's anyway (asked because the campaign has none), else the old first-line rule.
  const parsed = wantsSubject ? parseGeneratedEmail(result.generatedText) : { subject: null, body: result.generatedText.trim() };
  const hasOwnSubject = Boolean(campaign.subject?.trim());
  let subject: string;
  let aiBody = parsed.body;
  if (campaign.aiWritesSubject && parsed.subject) subject = parsed.subject;
  else if (hasOwnSubject) subject = own.subject;
  else if (parsed.subject) subject = parsed.subject;
  else ({ subject, body: aiBody } = splitLegacySubject(parsed.body));
  const { body, disclosureAppended } = appendEuAiDisclosureIfNeeded(aiBody, true, {
    email: lead.email,
    countryCode: countryCodeOf(lead),
  });
  return {
    subject,
    body,
    aiOutcome: 'AI_WRITTEN',
    aiFallbackReason: null,
    euAiDisclosureAppended: disclosureAppended,
    fallback: own,
  };
}
