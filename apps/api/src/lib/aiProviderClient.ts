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
import { checkGeminiModel, generateGeminiText } from './aiProviders/gemini';
import { checkClaudeModel, generateClaudeText } from './aiProviders/claude';

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
 *  blank — the most common single-mailbox use: keep the written email, tailor its opening. It asks
 *  for a sentence ADDED, not one "rewritten to speak to the lead": an email that already says
 *  "Hi Dana" reads as done to a cheap model, and gemini-3.5-flash-lite sent it back unchanged. */
export const DEFAULT_PERSONALIZE_INSTRUCTIONS =
  "Keep the greeting. Right after it, add one short sentence written for this lead that mentions one specific fact from the lead context (their company, role, city, what they're hiring for, product or news) and leads into the email. Keep it natural, no flattery.";

/** What the model is told in PROMPT mode when the campaign leaves its instructions blank. */
export const DEFAULT_PROMPT_INSTRUCTIONS =
  'Write a short, plain cold email to this lead in your own words. Open with one specific fact from the lead context, say what the sender offers in one or two sentences, and end with one question. Under 120 words, no hype words.';

/** A square-bracket placeholder a model leaves for the user to fill (`[Your Name]`, `[Company]`). */
const PLACEHOLDER = /\[(?:your|my|sender|insert|name|company|title|phone|link)[^\]\n]{0,40}\]/gi;

/** Takes out the placeholders a model was told not to write: `[Your Name]` becomes the sender's
 *  name when there is one, and a line left with nothing else on it goes. Seen 2026-10-05: AI
 *  writes with Gemini signed every email "[Your Name]", which would have gone to real leads. */
export function stripPlaceholders(text: string, senderName?: string | null): string {
  const name = senderName?.trim();
  return text
    .split('\n')
    .flatMap((line) => {
      const filled = line.replace(PLACEHOLDER, (p) => (name && /name/i.test(p) ? name : ''));
      if (filled === line) return [line.replace(/[ \t]+$/, '')];
      if (!filled.trim()) return [];
      return [
        filled
          .replace(/ {2,}/g, ' ')
          .replace(/ ([,.!?])/g, '$1')
          .trimEnd(),
      ];
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

/** The check run before a key is saved: one capped generation on the model the customer picked
 *  (`aiProviders/gemini.ts#checkGeminiModel` / `aiProviders/claude.ts#checkClaudeModel`). Listing
 *  models used to be the check, and it passed free Gemini keys for models they get no quota on —
 *  the key read "Configured" while every send fell back to the template. Returns the same reason
 *  code a failed send would get, so the route can say what to fix. An obviously-short key is
 *  refused without a network call. */
export async function checkProviderKey(
  provider: AiProvider,
  apiKey: string,
  model: string,
): Promise<{ ok: true } | { ok: false; reason: AiFallbackReason }> {
  if (!apiKey || apiKey.trim().length < 8) {
    return { ok: false, reason: 'key_rejected' };
  }
  try {
    await (provider === 'GEMINI'
      ? checkGeminiModel(apiKey, model)
      : checkClaudeModel(apiKey, model));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: classifyAiFailure(err) };
  }
}

/** A merge field: `{{name}}`, or `{{name|fallback}}` to use the fallback text when the lead's value
 *  is blank (`Hi {{firstName|there}},`). Group 1 is the name, group 2 the fallback when given. */
export const MERGE_TOKEN = /\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;

/** The key a merge-field name matches on: capitals, underscores, dashes and spaces don't count, so
 *  `{{dns_finding}}`, `{{dnsFinding}}` and `{{DNS Finding}}` all fill from a `dnsFinding` column. */
export function mergeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasValue(value: unknown): boolean {
  return (
    value !== null && value !== undefined && (typeof value !== 'string' || Boolean(value.trim()))
  );
}

/** Fills `{{fieldName}}` placeholders in `template` from `leadContext` (same mustache-style
 *  convention `lib/mailSender.ts#resolveUnsubscribeUrl` already uses for `{{email}}`). Exported so
 *  the no-AI-provider / inactive-key fallback path in `routes/internalAi.ts` can apply the same
 *  merge-field substitution to `campaign.template` directly, instead of a second implementation —
 *  this was originally private and only reachable via `buildPersonalizationPrompt` below, which
 *  runs solely on the AI-prompt path.
 *
 *  Names match by `mergeKey`, so capitals and underscores don't count. A blank value (null,
 *  missing, or only spaces) takes the token's fallback; with no fallback the token is left as written, never filled with an empty spot — the
 *  launch check (`lib/sendingReadiness.ts`) blocks a campaign that would send one. */
export function fillMergeFields(template: string, leadContext: Record<string, unknown>): string {
  const values = new Map<string, unknown>();
  for (const [key, value] of Object.entries(leadContext)) {
    const name = mergeKey(key);
    if (!hasValue(values.get(name))) values.set(name, value);
  }
  return template.replace(MERGE_TOKEN, (token, name: string, fallback: string | undefined) => {
    const value = values.get(mergeKey(name));
    if (hasValue(value)) return String(value);
    return fallback === undefined ? token : fallback.trim();
  });
}

/** Fills merge fields in `promptTemplate` (via `fillMergeFields` above), then appends the full lead
 *  context as a JSON block so the model can use fields the customer didn't explicitly template,
 *  without inventing facts not present in it. In PERSONALIZE mode the campaign's rendered email
 *  goes in too, with an instruction to keep everything the customer didn't ask to change. */
export function buildPersonalizationPrompt(
  request: Omit<PersonalizeRequest, 'provider' | 'apiKey' | 'model'>,
): string {
  const { leadContext, baseEmail, wantsSubject } = request;
  const hasEmail = Boolean(baseEmail?.trim());
  const personalize = request.mode === 'PERSONALIZE' && hasEmail;
  const instructions = fillMergeFields(
    request.promptTemplate.trim() ||
      (personalize
        ? DEFAULT_PERSONALIZE_INSTRUCTIONS
        : hasEmail
          ? DEFAULT_PROMPT_INSTRUCTIONS
          : ''),
    leadContext,
  );
  const senderName =
    typeof leadContext.senderName === 'string' ? leadContext.senderName.trim() : '';
  const outputRule = [
    wantsSubject
      ? 'Start with one line "Subject: <subject line>", then a blank line, then the email body. No preamble, no markdown formatting.'
      : 'Write only the finished email body text — no subject line, no preamble, no markdown formatting.',
    'Never write a placeholder in square brackets such as [Your Name] or [Company] — the email goes out exactly as you write it.',
  ].join(' ');

  // PROMPT mode gets the campaign's own email too, as the source of what the sender offers. Before
  // 2026-10-05 it got the instructions alone, and with blank instructions the model made up an
  // offer ("route optimization", "10 minutes next Tuesday") the sender never had.
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
    : hasEmail
      ? [
          instructions,
          '',
          "The sender's own email to this lead is below. Take what they offer, who they are and what they ask for from it, and add no product, claim, number or meeting time it doesn't have. Write in your own words — don't copy it.",
          '<sender_email>',
          baseEmail!.trim(),
          '</sender_email>',
        ]
      : [instructions];
  const signOff = personalize
    ? []
    : [
        senderName
          ? `Sign the email as ${senderName}.`
          : "Sign it with the name the sender's email uses; if there is none, end without a name.",
      ];
  return [
    ...parts,
    '',
    `Lead context (use only what's relevant; never invent facts not present here): ${JSON.stringify(leadContext)}`,
    '',
    ...signOff,
    outputRule,
  ].join('\n');
}

/** Splits a model reply into subject and body when it was asked for a `Subject:` first line.
 *  Tolerates the usual model decorations (`**Subject:**`, `Subject line:`); a reply with no such
 *  line comes back as `subject: null` with the whole text as the body. */
export function parseGeneratedEmail(text: string): { subject: string | null; body: string } {
  const trimmed = text.replace(/^\s+/, '');
  const match = /^\**\s*subject(?:\s+line)?\**\s*:\s*\**\s*(.*)$/im.exec(
    trimmed.split('\n')[0] ?? '',
  );
  if (!match) return { subject: null, body: text.trim() };
  const subject = match[1].replace(/\*+$/, '').trim();
  const body = trimmed.split('\n').slice(1).join('\n').trim();
  return { subject: subject || null, body };
}

/** Why a personalization call failed, as a short stable code stored on the send's ExecutionLog.
 *  Reads the HTTP status out of the provider error message (`aiProviders/*` put it there) rather
 *  than importing their error classes, so this stays callable where those modules are mocked. */
export type AiFallbackReason =
  'provider_error' | 'model_unavailable' | 'key_rejected' | 'key_missing' | 'quota_exceeded';

export function classifyAiFailure(err: unknown): AiFallbackReason {
  const message = err instanceof Error ? err.message : String(err);
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (status === '404') return 'model_unavailable';
  if (status === '401' || status === '403') return 'key_rejected';
  // 429 is a quota answer, not an outage: a free Gemini key gets it on every call to a model its
  // tier doesn't cover, so retrying later doesn't help — picking another model or adding billing does.
  if (status === '429') return 'quota_exceeded';
  if (status === '400') {
    // Gemini answers a bad key with 400 API_KEY_INVALID, not 401; Claude answers an empty
    // prepaid balance with 400 "credit balance is too low".
    if (/API_KEY_INVALID|API key not valid/i.test(message)) return 'key_rejected';
    if (/credit balance is too low/i.test(message)) return 'quota_exceeded';
  }
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

/** Keyword-heuristic classifier — the resilient fallback for `classifyReply` below when the
 *  provider call fails (a timeout, an expired key), and the whole classifier on an install with no
 *  AI key at all (`routes/internalAi.ts`), so OPT_OUT auto-suppression never depends on one.
 *  Callers pass the reply with the quoted original stripped (`lib/replyText.ts`): every email we
 *  send carries "Unsubscribe:" in its footer, so run on a full reply this reads nearly everything
 *  as an opt-out. A bare "stop" stays out on purpose — "don't stop" is a live lead. */
export function classifyByKeyword(content: string): ReplyClassificationLabel {
  const lower = content.toLowerCase();
  if (!lower.trim()) return 'UNCLASSIFIED';
  if (
    /unsubscribe|remove me|opt out|stop emailing|take me off|do not contact|don'?t email/.test(
      lower,
    )
  ) {
    return 'OPT_OUT';
  }
  if (/out of office|on vacation|away from my desk/.test(lower)) return 'OUT_OF_OFFICE';
  if (/automatic reply|auto-reply|do not reply/.test(lower)) return 'AUTO_REPLY';
  if (/not interested|uninterested|no thanks|please remove/.test(lower)) return 'NOT_INTERESTED';
  if (/interested|let's talk|sounds good|schedule a call|book a time/.test(lower))
    return 'INTERESTED';
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
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z_]/g, '');
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
