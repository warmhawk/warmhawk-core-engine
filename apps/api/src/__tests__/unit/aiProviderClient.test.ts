/**
 * Unit tests for the provider-agnostic dispatcher (`lib/aiProviderClient.ts`). The real
 * `aiProviders/gemini.ts` / `aiProviders/claude.ts` modules are mocked here — this file tests
 * dispatch, prompt-building, and the classification fallback, not the real HTTP calls (see
 * `aiProviders.test.ts` for those, which mock `global.fetch` instead).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkProviderKey,
  personalizeContent,
  classifyReply,
  fillMergeFields,
} from '../../lib/aiProviderClient';
import * as gemini from '../../lib/aiProviders/gemini';
import * as claude from '../../lib/aiProviders/claude';

vi.mock('../../lib/aiProviders/gemini', () => ({
  checkGeminiModel: vi.fn(),
  generateGeminiText: vi.fn(),
}));
vi.mock('../../lib/aiProviders/claude', () => ({
  checkClaudeModel: vi.fn(),
  generateClaudeText: vi.fn(),
}));

describe('checkProviderKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses an obviously-short key without calling either provider', async () => {
    const result = await checkProviderKey('GEMINI', 'short', 'gemini-3.5-flash-lite');
    expect(result).toEqual({ ok: false, reason: 'key_rejected' });
    expect(gemini.checkGeminiModel).not.toHaveBeenCalled();
  });

  it('checks the chosen Gemini model for provider GEMINI', async () => {
    vi.mocked(gemini.checkGeminiModel).mockResolvedValue(undefined);
    await expect(
      checkProviderKey('GEMINI', 'a-real-looking-key', 'gemini-3.5-flash-lite'),
    ).resolves.toEqual({
      ok: true,
    });
    expect(gemini.checkGeminiModel).toHaveBeenCalledWith(
      'a-real-looking-key',
      'gemini-3.5-flash-lite',
    );
    expect(claude.checkClaudeModel).not.toHaveBeenCalled();
  });

  it('checks the chosen Claude model for provider CLAUDE', async () => {
    vi.mocked(claude.checkClaudeModel).mockResolvedValue(undefined);
    await expect(
      checkProviderKey('CLAUDE', 'a-real-looking-key', 'claude-haiku-4-5'),
    ).resolves.toEqual({ ok: true });
    expect(claude.checkClaudeModel).toHaveBeenCalledWith('a-real-looking-key', 'claude-haiku-4-5');
    expect(gemini.checkGeminiModel).not.toHaveBeenCalled();
  });

  it('returns the failure reason a send would get — a free key on a paid model is quota_exceeded', async () => {
    vi.mocked(gemini.checkGeminiModel).mockRejectedValue(
      new Error('Gemini key check failed with HTTP 429: RESOURCE_EXHAUSTED'),
    );
    await expect(
      checkProviderKey('GEMINI', 'a-real-looking-key', 'gemini-3.8-flash'),
    ).resolves.toEqual({
      ok: false,
      reason: 'quota_exceeded',
    });
  });
});

describe('personalizeContent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fills {{field}} placeholders from leadContext and includes the JSON context block', async () => {
    vi.mocked(gemini.generateGeminiText).mockResolvedValue('Generated body');
    const result = await personalizeContent({
      provider: 'GEMINI',
      apiKey: 'k',
      model: 'gemini-pro',
      promptTemplate: 'Write a short intro for {{firstName}} at {{company}}.',
      leadContext: { firstName: 'Ada', company: 'Acme' },
    });
    expect(result.generatedText).toBe('Generated body');
    const promptArg = vi.mocked(gemini.generateGeminiText).mock.calls[0][0].prompt;
    expect(promptArg).toContain('Write a short intro for Ada at Acme.');
    expect(promptArg).toContain('"firstName":"Ada"');
  });

  it('dispatches to Claude for provider CLAUDE', async () => {
    vi.mocked(claude.generateClaudeText).mockResolvedValue('Claude body');
    const result = await personalizeContent({
      provider: 'CLAUDE',
      apiKey: 'k',
      model: 'claude-3',
      promptTemplate: 'Hello {{firstName}}',
      leadContext: { firstName: 'Grace' },
    });
    expect(result.generatedText).toBe('Claude body');
    expect(gemini.generateGeminiText).not.toHaveBeenCalled();
  });

  it('propagates a provider error to the caller (no swallowing)', async () => {
    vi.mocked(gemini.generateGeminiText).mockRejectedValue(new Error('boom'));
    await expect(
      personalizeContent({
        provider: 'GEMINI',
        apiKey: 'k',
        model: 'gemini-pro',
        promptTemplate: 'hi',
        leadContext: {},
      }),
    ).rejects.toThrow('boom');
  });
});

/**
 * `fillMergeFields` — extracted from `buildPersonalizationPrompt`'s previously-private inline loop
 * (API-surface correction pass: `routes/internalAi.ts`'s no-AI-provider / inactive-key fallback
 * path now reuses this exact function on `campaign.template`, instead of a second implementation —
 * see that file's `renderFallbackTemplate`). `personalizeContent`'s own test above already covers
 * it indirectly via the AI-prompt path; these cover it directly.
 */
describe('fillMergeFields', () => {
  it('fills every matching {{field}} placeholder, case-insensitively', () => {
    expect(
      fillMergeFields('Hi {{FirstName}} at {{company}}', { firstName: 'Ada', company: 'Acme' }),
    ).toBe('Hi Ada at Acme');
  });

  it('leaves a placeholder with no matching field as literal text', () => {
    expect(fillMergeFields('Hi {{nickname}}', { firstName: 'Ada' })).toBe('Hi {{nickname}}');
  });

  it('skips null/undefined context values rather than substituting the literal word', () => {
    expect(fillMergeFields('Hi {{firstName}}', { firstName: null })).toBe('Hi {{firstName}}');
  });

  it('tolerates whitespace inside the braces ({{ field }})', () => {
    expect(fillMergeFields('Hi {{ firstName }}', { firstName: 'Ada' })).toBe('Hi Ada');
  });

  it('renders plain text with no placeholders unchanged', () => {
    expect(fillMergeFields('Just checking in.', { firstName: 'Ada' })).toBe('Just checking in.');
  });

  it('uses a {{field|fallback}} when the value is missing, null or blank', () => {
    const text = 'Hi {{firstName|there}}, {{ role | your team }} and {{nickname|friend}}.';
    expect(fillMergeFields(text, { firstName: null, role: '  ' })).toBe(
      'Hi there, your team and friend.',
    );
    expect(fillMergeFields(text, { firstName: 'Ada', role: 'SDR', nickname: 'A' })).toBe(
      'Hi Ada, SDR and A.',
    );
    expect(fillMergeFields('Hi{{firstName|}},', { firstName: '' })).toBe('Hi,');
  });

  it('leaves a blank value with no fallback as written, never an empty spot', () => {
    expect(fillMergeFields('hiring a {{role}}.', { role: '' })).toBe('hiring a {{role}}.');
  });

  it('keeps the first non-blank value when two keys differ only in case', () => {
    expect(fillMergeFields('{{city}}', { city: '', City: 'Austin' })).toBe('Austin');
    expect(fillMergeFields('{{city}}', { city: 'Dallas', City: 'Austin' })).toBe('Dallas');
  });

  it('matches a name whatever its capitals and underscores', () => {
    const context = { dnsFinding: 'No DMARC record.', top_fix: 'Add DMARC.' };
    expect(fillMergeFields('{{dns_finding}} {{DNS_Finding}} {{topFix}}', context)).toBe(
      'No DMARC record. No DMARC record. Add DMARC.',
    );
    expect(fillMergeFields('{{dnsFinding}}', { dns_finding: '', dnsFinding: 'Set.' })).toBe('Set.');
  });

  it('fills a field name with spaces, and inserts a value with $ as it is', () => {
    expect(fillMergeFields('{{Deal Size}}', { 'Deal Size': '$&100' })).toBe('$&100');
  });
});

describe('classifyReply', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns UNCLASSIFIED for empty content without calling the provider', async () => {
    const result = await classifyReply({
      provider: 'GEMINI',
      apiKey: 'k',
      model: 'm',
      replyContent: '   ',
    });
    expect(result.classification).toBe('UNCLASSIFIED');
    expect(gemini.generateGeminiText).not.toHaveBeenCalled();
  });

  it('parses a clean single-word label from the provider response', async () => {
    vi.mocked(gemini.generateGeminiText).mockResolvedValue('OPT_OUT');
    const result = await classifyReply({
      provider: 'GEMINI',
      apiKey: 'k',
      model: 'm',
      replyContent: 'Please unsubscribe me.',
    });
    expect(result.classification).toBe('OPT_OUT');
  });

  it('tolerates surrounding whitespace/punctuation in the provider response', async () => {
    vi.mocked(claude.generateClaudeText).mockResolvedValue('  interested.\n');
    const result = await classifyReply({
      provider: 'CLAUDE',
      apiKey: 'k',
      model: 'm',
      replyContent: "Sounds good, let's talk.",
    });
    expect(result.classification).toBe('INTERESTED');
  });

  it('falls back to the keyword heuristic when the provider returns an unparseable label', async () => {
    vi.mocked(gemini.generateGeminiText).mockResolvedValue('I am not sure, maybe interested?');
    const result = await classifyReply({
      provider: 'GEMINI',
      apiKey: 'k',
      model: 'm',
      replyContent: 'No thanks, not interested in this.',
    });
    expect(result.classification).toBe('NOT_INTERESTED');
  });

  it('falls back to the keyword heuristic when the provider call throws — OPT_OUT must never be lost', async () => {
    vi.mocked(gemini.generateGeminiText).mockRejectedValue(new Error('provider timeout'));
    const result = await classifyReply({
      provider: 'GEMINI',
      apiKey: 'k',
      model: 'm',
      replyContent: 'Please unsubscribe me immediately.',
    });
    expect(result.classification).toBe('OPT_OUT');
  });
});
