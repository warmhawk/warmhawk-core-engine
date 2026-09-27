/**
 * AI provider client — BYOK personalization + reply classification. Real HTTP calls to Gemini's
 * `generateContent` and Claude's Messages API (see `aiProviders/gemini.ts` / `aiProviders/claude.ts`
 * for the actual `fetch` calls) — this file is the provider-agnostic dispatcher every call site
 * (`routes/aiProviders.ts`, `routes/internalAi.ts`) depends on, so neither of them needs to know
 * which provider a campaign picked.
 *
 * API-surface correction pass: this was previously a deliberate stub (length-check "validation," a
 * hardcoded placeholder string, regex-only classification), per an earlier instruction not to make
 * live paid-API calls during that build. Now wired to real calls, at the user's explicit direction.
 * Tests must still never hit a live endpoint — mock `global.fetch` (or the `aiProviders/*` module)
 * at the call site, exactly as the file header this replaces originally required.
 */
import type { AiProvider } from '@warmhawk/db';
import { validateGeminiKey, generateGeminiText } from './aiProviders/gemini';
import { validateClaudeKey, generateClaudeText } from './aiProviders/claude';

export interface PersonalizeRequest {
  provider: AiProvider;
  apiKey: string;
  model: string;
  promptTemplate: string;
  leadContext: Record<string, unknown>;
  /** PERSONALIZE hands the model `baseEmail` and asks it to change only what `promptTemplate`
   *  names; PROMPT (the default, and the only behavior before campaigns had a mode) has it write
   *  the whole email from `promptTemplate`. PERSONALIZE with no `baseEmail` behaves as PROMPT. */
  mode?: 'PERSONALIZE' | 'PROMPT';
  /** The campaign's own email, already rendered for this lead (merge fields + spintax). */
  baseEmail?: string;
  /** Ask for a `Subject:` first line — see `parseGeneratedEmail`. */
  wantsSubject?: boolean;
}

/** What the model is told to do in PERSONALIZE mode when the campaign leaves its instructions
 *  blank — the most common single-mailbox use: keep the written email, tailor its opening. */
export const DEFAULT_PERSONALIZE_INSTRUCTIONS =
  "Rewrite only the opening line so it speaks to this lead's company or role.";

export interface PersonalizeResult {
  generatedText: string;
}

export interface ClassifyReplyRequest {
  provider: AiProvider;
  apiKey: string;
  model: string;
  replyContent: string;
}

export type ReplyClassificationLabel =
  'INTERESTED' | 'NOT_INTERESTED' | 'OUT_OF_OFFICE' | 'AUTO_REPLY' | 'OPT_OUT' | 'UNCLASSIFIED';

export interface ClassifyReplyResult {
  classification: ReplyClassificationLabel;
}

const CLASSIFICATION_LABELS: ReplyClassificationLabel[] = [
  'INTERESTED',
  'NOT_INTERESTED',
  'OUT_OF_OFFICE',
  'AUTO_REPLY',
  'OPT_OUT',
  'UNCLASSIFIED',
];

/** One lightweight validation call, per Phase 3: "save (encrypt + one lightweight test call to
 *  validate the key before persisting)". Real, near-zero-cost per-provider calls (model listing,
 *  never a generation) — see `aiProviders/gemini.ts#validateGeminiKey` /
 *  `aiProviders/claude.ts#validateClaudeKey`. Still returns `false` outright for an obviously-empty
 *  key without making a network call at all, so that one unit-testable fast path stays dependency-
 *  free. */
export async function validateProviderKey(provider: AiProvider, apiKey: string): Promise<boolean> {
  if (!apiKey || apiKey.trim().length < 8) {
    return false;
  }
  return provider === 'GEMINI' ? validateGeminiKey(apiKey) : validateClaudeKey(apiKey);
}

/** Fills `{{fieldName}}` placeholders in `template` from `leadContext` (same mustache-style
 *  convention `lib/mailSender.ts#resolveUnsubscribeUrl` already uses for `{{email}}`). Exported so
 *  the no-AI-provider / inactive-key fallback path in `routes/internalAi.ts` can apply the same
 *  merge-field substitution to `campaign.template` directly, instead of a second implementation —
 *  this was originally private and only reachable via `buildPersonalizationPrompt` below, which
 *  runs solely on the AI-prompt path. */
export function fillMergeFields(template: string, leadContext: Record<string, unknown>): string {
  let filled = template;
  for (const [key, value] of Object.entries(leadContext)) {
    if (value === null || value === undefined) continue;
    const pattern = new RegExp(`\\{\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'gi');
    filled = filled.replace(pattern, String(value));
  }
  return filled;
}

/** Fills merge fields in `promptTemplate` (via `fillMergeFields` above), then appends the full lead
 *  context as a JSON block so the model can use fields the customer didn't explicitly template,
 *  without inventing facts not present in it. In PERSONALIZE mode the campaign's rendered email
 *  goes in too, with an instruction to keep everything the customer didn't ask to change. */
export function buildPersonalizationPrompt(request: Omit<PersonalizeRequest, 'provider' | 'apiKey' | 'model'>): string {
  const { leadContext, baseEmail, wantsSubject } = request;
  const personalize = request.mode === 'PERSONALIZE' && Boolean(baseEmail?.trim());
  const instructions = fillMergeFields(
    request.promptTemplate.trim() || (personalize ? DEFAULT_PERSONALIZE_INSTRUCTIONS : ''),
    leadContext,
  );
  const outputRule = wantsSubject
    ? 'Start with one line "Subject: <subject line>", then a blank line, then the email body. No preamble, no markdown formatting, no placeholder brackets left unfilled.'
    : 'Write only the finished email body text — no subject line, no preamble, no markdown formatting, no placeholder brackets left unfilled.';

  const parts = personalize
    ? [
        'Here is a cold email already written for this lead:',
        '<email>',
        baseEmail!.trim(),
        '</email>',
        '',
        `Instructions: ${instructions}`,
        'Change only what the instructions ask for. Keep every other sentence word for word, including the sign-off.',
      ]
    : [instructions];
  return [
    ...parts,
    '',
    `Lead context (use only what's relevant; never invent facts not present here): ${JSON.stringify(leadContext)}`,
    '',
    outputRule,
  ].join('\n');
}

/** Splits a model reply into subject and body when it was asked for a `Subject:` first line.
 *  Tolerates the usual model decorations (`**Subject:**`, `Subject line:`); a reply with no such
 *  line comes back as `subject: null` with the whole text as the body. */
export function parseGeneratedEmail(text: string): { subject: string | null; body: string } {
  const trimmed = text.replace(/^\s+/, '');
  const match = /^\**\s*subject(?:\s+line)?\**\s*:\s*\**\s*(.*)$/im.exec(trimmed.split('\n')[0] ?? '');
  if (!match) return { subject: null, body: text.trim() };
  const subject = match[1].replace(/\*+$/, '').trim();
  const body = trimmed.split('\n').slice(1).join('\n').trim();
  return { subject: subject || null, body };
}

/** Why a personalization call failed, as a short stable code stored on the send's ExecutionLog.
 *  Reads the HTTP status out of the provider error message (`aiProviders/*` put it there) rather
 *  than importing their error classes, so this stays callable where those modules are mocked. */
export type AiFallbackReason = 'provider_error' | 'model_unavailable' | 'key_rejected' | 'key_missing';

export function classifyAiFailure(err: unknown): AiFallbackReason {
  const status = /HTTP (\d{3})/.exec(err instanceof Error ? err.message : String(err))?.[1];
  if (status === '404') return 'model_unavailable';
  if (status === '401' || status === '403') return 'key_rejected';
  return 'provider_error';
}

/** Real personalization call, dispatched by provider. The plaintext key is available only inside
 *  this function call's scope; callers must never log or persist it. Throws on failure — the
 *  caller (`routes/internalAi.ts`) owns the retry-once-then-fall-back-to-template policy, since
 *  only it knows what "fall back" means for a given send (the unmodified template, sent as-is). */
export async function personalizeContent(request: PersonalizeRequest): Promise<PersonalizeResult> {
  const prompt = buildPersonalizationPrompt(request);
  const generatedText =
    request.provider === 'GEMINI'
      ? await generateGeminiText({ apiKey: request.apiKey, model: request.model, prompt })
      : await generateClaudeText({ apiKey: request.apiKey, model: request.model, prompt });
  return { generatedText };
}

/** Keyword-heuristic classifier — kept as the resilient fallback for `classifyReply` below (used
 *  only when the real provider call itself fails, e.g. a timeout or an expired key on an inbox
 *  that's actively receiving replies) so a transient AI-provider outage never silently drops every
 *  reply to UNCLASSIFIED, including the compliance-sensitive OPT_OUT case. Same patterns as this
 *  file's original stub implementation. */
function classifyByKeyword(content: string): ReplyClassificationLabel {
  const lower = content.toLowerCase();
  if (!lower.trim()) return 'UNCLASSIFIED';
  if (/unsubscribe|remove me|opt out|stop emailing/.test(lower)) return 'OPT_OUT';
  if (/out of office|on vacation|away from my desk/.test(lower)) return 'OUT_OF_OFFICE';
  if (/automatic reply|auto-reply|do not reply/.test(lower)) return 'AUTO_REPLY';
  if (/not interested|no thanks|please remove/.test(lower)) return 'NOT_INTERESTED';
  if (/interested|let's talk|sounds good|schedule a call|book a time/.test(lower)) return 'INTERESTED';
  return 'UNCLASSIFIED';
}

const CLASSIFICATION_PROMPT_PREFIX = `Classify this email reply into EXACTLY ONE of these labels: ${CLASSIFICATION_LABELS.join(', ')}.
- OPT_OUT: asks to be removed/unsubscribed/stop being emailed.
- OUT_OF_OFFICE: an automated "I'm away" reply.
- AUTO_REPLY: any other automated/no-reply response.
- NOT_INTERESTED: a real person declining.
- INTERESTED: a real person expressing interest or willingness to talk further.
- UNCLASSIFIED: anything that doesn't clearly fit the above.
Respond with ONLY the single label word, nothing else.

Reply content:
`;

function parseClassificationLabel(raw: string): ReplyClassificationLabel | null {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z_]/g, '');
  return (CLASSIFICATION_LABELS as string[]).includes(cleaned)
    ? (cleaned as ReplyClassificationLabel)
    : null;
}

/** Real classification call, dispatched by provider. Falls back to the keyword heuristic above if
 *  the provider call throws OR returns text that doesn't parse cleanly to one of the six labels —
 *  a reply must always get SOME classification, since OPT_OUT driving auto-suppression is a
 *  Guardrails requirement, not best-effort. */
export async function classifyReply(request: ClassifyReplyRequest): Promise<ClassifyReplyResult> {
  if (!request.replyContent.trim()) {
    return { classification: 'UNCLASSIFIED' };
  }

  const prompt = `${CLASSIFICATION_PROMPT_PREFIX}${request.replyContent}`;
  try {
    const generated =
      request.provider === 'GEMINI'
        ? await generateGeminiText({ apiKey: request.apiKey, model: request.model, prompt })
        : await generateClaudeText({ apiKey: request.apiKey, model: request.model, prompt });
    const parsed = parseClassificationLabel(generated);
    return { classification: parsed ?? classifyByKeyword(request.replyContent) };
  } catch {
    return { classification: classifyByKeyword(request.replyContent) };
  }
}
