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
}

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

/** Fills `{{fieldName}}` placeholders in `promptTemplate` from `leadContext` (same mustache-style
 *  convention `lib/mailSender.ts#resolveUnsubscribeUrl` already uses for `{{email}}`), then appends
 *  the full lead context as a JSON block so the model can use fields the customer didn't explicitly
 *  template, without inventing facts not present in it. */
function buildPersonalizationPrompt(promptTemplate: string, leadContext: Record<string, unknown>): string {
  let filled = promptTemplate;
  for (const [key, value] of Object.entries(leadContext)) {
    if (value === null || value === undefined) continue;
    const pattern = new RegExp(`\\{\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'gi');
    filled = filled.replace(pattern, String(value));
  }
  return [
    filled,
    '',
    `Lead context (use only what's relevant; never invent facts not present here): ${JSON.stringify(leadContext)}`,
    '',
    'Write only the finished email body text — no subject line, no preamble, no markdown formatting, no placeholder brackets left unfilled.',
  ].join('\n');
}

/** Real personalization call, dispatched by provider. The plaintext key is available only inside
 *  this function call's scope; callers must never log or persist it. Throws on failure — the
 *  caller (`routes/internalAi.ts`) owns the retry-once-then-fall-back-to-template policy, since
 *  only it knows what "fall back" means for a given send (the unmodified template, sent as-is). */
export async function personalizeContent(request: PersonalizeRequest): Promise<PersonalizeResult> {
  const prompt = buildPersonalizationPrompt(request.promptTemplate, request.leadContext);
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
