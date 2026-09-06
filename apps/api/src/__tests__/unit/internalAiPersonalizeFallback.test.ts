/**
 * Unit test for the retry-once-then-fall-back-to-template policy in
 * `routes/internalAi.ts#personalizeWithFallback` — resolved when real AI provider calls were
 * wired in: a flaky provider must retry exactly once, then fall back to the campaign's own
 * template so a send never stalls on it. Fake timers avoid actually waiting out the retry delay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { personalizeWithFallback, renderFallbackTemplate } from '../../routes/internalAi';
import * as aiProviderClient from '../../lib/aiProviderClient';

vi.mock('../../lib/aiProviderClient', async () => {
  const actual = await vi.importActual<typeof aiProviderClient>('../../lib/aiProviderClient');
  return { ...actual, personalizeContent: vi.fn() };
});

const baseRequest = {
  provider: 'GEMINI' as const,
  apiKey: 'k',
  model: 'gemini-pro',
  promptTemplate: 'Say hi to {{firstName}}',
  leadContext: { firstName: 'Ada' },
};

describe('personalizeWithFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the AI result immediately on first-try success, no retry', async () => {
    vi.mocked(aiProviderClient.personalizeContent).mockResolvedValueOnce({ generatedText: 'Hi Ada!' });
    const result = await personalizeWithFallback(baseRequest, 'fallback template text');
    expect(result).toEqual({ generatedText: 'Hi Ada!', aiUsed: true, aiPersonalizationFailed: false });
    expect(aiProviderClient.personalizeContent).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once after a transient failure, then returns the retry success', async () => {
    vi.mocked(aiProviderClient.personalizeContent)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ generatedText: 'Hi Ada, on retry!' });

    const resultPromise = personalizeWithFallback(baseRequest, 'fallback template text');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({
      generatedText: 'Hi Ada, on retry!',
      aiUsed: true,
      aiPersonalizationFailed: false,
    });
    expect(aiProviderClient.personalizeContent).toHaveBeenCalledTimes(2);
  });

  it('falls back to the template and flags the failure after two consecutive failures', async () => {
    vi.mocked(aiProviderClient.personalizeContent)
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('still down'));

    const resultPromise = personalizeWithFallback(baseRequest, 'fallback template text');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({
      generatedText: 'fallback template text',
      aiUsed: false,
      aiPersonalizationFailed: true,
    });
    expect(aiProviderClient.personalizeContent).toHaveBeenCalledTimes(2);
  });
});

/**
 * Unit coverage for `renderFallbackTemplate` — the fix for the bug this whole file guards against
 * (see the file header and internalAiPersonalize.integration.test.ts for the end-to-end version).
 * No real DB needed here: this is pure string transformation, so it's the fast/always-runs
 * complement to the integration test.
 */
describe('renderFallbackTemplate', () => {
  it('substitutes merge fields and resolves a spintax group in one template', () => {
    const rendered = renderFallbackTemplate(
      'Hi {{firstName}}, {Quick question|One thing I noticed} about {{company}}.',
      { firstName: 'Ada', company: 'Acme' },
    );
    expect(rendered).not.toMatch(/\{\{.*\}\}/);
    expect(rendered).not.toMatch(/\{[^{}]*\|[^{}]*\}/);
    expect(rendered).toContain('Hi Ada,');
    expect(rendered).toContain('about Acme.');
  });

  it('renders merge fields BEFORE spintax — the collision this bug would reintroduce if reordered', () => {
    // {{firstName}} is itself a balanced {...} pair one level in. If spintax ran first, its
    // innermost-group scan would treat the inner {firstName} as a single-option (no-pipe) spintax
    // group and collapse the whole thing to the literal text "firstName" — losing the merge field
    // entirely before merge-field substitution ever got a chance to run. This is exactly the
    // ordering renderFallbackTemplate's own header comment explains.
    const rendered = renderFallbackTemplate('Hello {{firstName}}!', { firstName: 'Grace' });
    expect(rendered).toBe('Hello Grace!');
    expect(rendered).not.toContain('firstName');
  });

  it('renders plain text with no template syntax unchanged', () => {
    expect(renderFallbackTemplate('Just checking in.', { firstName: 'Ada' })).toBe('Just checking in.');
  });

  it('does not throw on an unmatched merge field (no such lead field) — leaves it literal rather than mangling it', () => {
    // fillMergeFields correctly leaves `{{nickname}}` untouched when there's no matching lead
    // field (see aiProviderClient.test.ts's own coverage of that). spintax.ts's doubled-brace
    // exclusion (added for the issues 4/5 merge-field/spintax collision fix — see its own header
    // comment) means renderSpintax now recognizes `{{...}}` as merge-field shape and leaves it
    // alone too, instead of the old accidental behavior of treating the inner `{nickname}` as a
    // single-option spintax group and stripping it to the bare word "nickname". Literal
    // `{{nickname}}` reaching the recipient is a visible, debuggable signal that the campaign
    // references a field the lead doesn't have — standard mail-merge convention (unmatched tags
    // stay visible rather than being silently corrupted into nonsense filler text) — and strictly
    // better than silently sending "Hi nickname!" with no indication anything was wrong.
    const rendered = renderFallbackTemplate('Hi {{nickname}}!', { firstName: 'Ada' });
    expect(rendered).toBe('Hi {{nickname}}!');
  });
});
