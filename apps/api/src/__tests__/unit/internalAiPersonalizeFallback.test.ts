/**
 * Unit test for the retry-once-then-fall-back-to-template policy in
 * `routes/internalAi.ts#personalizeWithFallback` — resolved when real AI provider calls were
 * wired in: a flaky provider must retry exactly once, then fall back to the campaign's own
 * template so a send never stalls on it. Fake timers avoid actually waiting out the retry delay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { personalizeWithFallback } from '../../routes/internalAi';
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
