/**
 * Unit tests for the provider-agnostic dispatcher (`lib/aiProviderClient.ts`). The real
 * `aiProviders/gemini.ts` / `aiProviders/claude.ts` modules are mocked here — this file tests
 * dispatch, prompt-building, and the classification fallback, not the real HTTP calls (see
 * `aiProviders.test.ts` for those, which mock `global.fetch` instead).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateProviderKey,
  personalizeContent,
  classifyReply,
  fillMergeFields,
} from '../../lib/aiProviderClient';
import * as gemini from '../../lib/aiProviders/gemini';
import * as claude from '../../lib/aiProviders/claude';

vi.mock('../../lib/aiProviders/gemini', () => ({
  validateGeminiKey: vi.fn(),
  generateGeminiText: vi.fn(),
}));
vi.mock('../../lib/aiProviders/claude', () => ({
  validateClaudeKey: vi.fn(),
  generateClaudeText: vi.fn(),
}));

describe('validateProviderKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false for an obviously-short key without calling either provider', async () => {
    const result = await validateProviderKey('GEMINI', 'short');
    expect(result).toBe(false);
    expect(gemini.validateGeminiKey).not.toHaveBeenCalled();
  });

  it('dispatches to validateGeminiKey for provider GEMINI', async () => {
    vi.mocked(gemini.validateGeminiKey).mockResolvedValue(true);
    await expect(validateProviderKey('GEMINI', 'a-real-looking-key')).resolves.toBe(true);
    expect(gemini.validateGeminiKey).toHaveBeenCalledWith('a-real-looking-key');
    expect(claude.validateClaudeKey).not.toHaveBeenCalled();
  });

  it('dispatches to validateClaudeKey for provider CLAUDE', async () => {
    vi.mocked(claude.validateClaudeKey).mockResolvedValue(false);
    await expect(validateProviderKey('CLAUDE', 'a-real-looking-key')).resolves.toBe(false);
    expect(claude.validateClaudeKey).toHaveBeenCalledWith('a-real-looking-key');
    expect(gemini.validateGeminiKey).not.toHaveBeenCalled();
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
    expect(fillMergeFields('Hi {{FirstName}} at {{company}}', { firstName: 'Ada', company: 'Acme' })).toBe(
      'Hi Ada at Acme',
    );
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
});

describe('classifyReply', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns UNCLASSIFIED for empty content without calling the provider', async () => {
    const result = await classifyReply({ provider: 'GEMINI', apiKey: 'k', model: 'm', replyContent: '   ' });
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
