/**
 * Unit tests for the real Gemini/Claude `fetch` wrappers — global.fetch is mocked throughout, per
 * this repo's own established convention (aiProviderClient.ts's header comment): tests must never
 * make a live call to a paid provider API.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateGeminiKey, generateGeminiText, GeminiApiError } from '../../lib/aiProviders/gemini';
import { validateClaudeKey, generateClaudeText, ClaudeApiError } from '../../lib/aiProviders/claude';

describe('aiProviders/gemini', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('validateGeminiKey returns true on a 2xx models-list response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    await expect(validateGeminiKey('fake-key')).resolves.toBe(true);
  });

  it('validateGeminiKey returns false on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);
    await expect(validateGeminiKey('fake-key')).resolves.toBe(false);
  });

  it('validateGeminiKey returns false (not throws) on a network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(validateGeminiKey('fake-key')).resolves.toBe(false);
  });

  it('generateGeminiText returns the candidate text on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Hello there!' }] } }] }),
    } as Response);
    const result = await generateGeminiText({ apiKey: 'k', model: 'gemini-pro', prompt: 'hi' });
    expect(result).toBe('Hello there!');
  });

  it('generateGeminiText throws GeminiApiError on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    } as Response);
    await expect(
      generateGeminiText({ apiKey: 'k', model: 'gemini-pro', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(GeminiApiError);
  });

  it('generateGeminiText throws GeminiApiError when the response has no usable text', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [] }) } as Response);
    await expect(
      generateGeminiText({ apiKey: 'k', model: 'gemini-pro', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(GeminiApiError);
  });
});

describe('aiProviders/claude', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('validateClaudeKey returns true on a 2xx models-list response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    await expect(validateClaudeKey('fake-key')).resolves.toBe(true);
  });

  it('validateClaudeKey returns false on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response);
    await expect(validateClaudeKey('fake-key')).resolves.toBe(false);
  });

  it('generateClaudeText returns the text block on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'Hi from Claude' }] }),
    } as Response);
    const result = await generateClaudeText({ apiKey: 'k', model: 'claude-3', prompt: 'hi' });
    expect(result).toBe('Hi from Claude');
  });

  it('generateClaudeText throws ClaudeApiError on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    } as Response);
    await expect(
      generateClaudeText({ apiKey: 'k', model: 'claude-3', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(ClaudeApiError);
  });

  it('generateClaudeText throws ClaudeApiError when no text block is present', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [] }) } as Response);
    await expect(
      generateClaudeText({ apiKey: 'k', model: 'claude-3', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(ClaudeApiError);
  });
});
