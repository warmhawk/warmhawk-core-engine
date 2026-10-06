/**
 * Unit tests for the real Gemini/Claude `fetch` wrappers — global.fetch is mocked throughout, per
 * this repo's own established convention (aiProviderClient.ts's header comment): tests must never
 * make a live call to a paid provider API.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkGeminiModel, generateGeminiText, GeminiApiError } from '../../lib/aiProviders/gemini';
import { checkClaudeModel, generateClaudeText, ClaudeApiError } from '../../lib/aiProviders/claude';

describe('aiProviders/gemini', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('checkGeminiModel calls the chosen model with the key in a header, never the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock;
    await expect(checkGeminiModel('fake-key', 'gemini-3.5-flash-lite')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/models\/gemini-3\.5-flash-lite:generateContent$/);
    expect(url).not.toContain('fake-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('fake-key');
    expect(JSON.parse(init.body as string).generationConfig.maxOutputTokens).toBeLessThanOrEqual(
      16,
    );
  });

  it('checkGeminiModel throws with the HTTP status when the model refuses (free-tier 429)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'RESOURCE_EXHAUSTED',
    } as Response);
    await expect(checkGeminiModel('fake-key', 'gemini-3.8-flash')).rejects.toThrow(/HTTP 429/);
  });

  it('checkGeminiModel throws GeminiApiError on a network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(checkGeminiModel('fake-key', 'gemini-3.5-flash-lite')).rejects.toBeInstanceOf(
      GeminiApiError,
    );
  });

  it('generateGeminiText sends the key in a header, never the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Hi' }] } }] }),
    } as Response);
    global.fetch = fetchMock;
    await generateGeminiText({ apiKey: 'fake-key', model: 'gemini-pro', prompt: 'hi' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('fake-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('fake-key');
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
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ candidates: [] }) } as Response);
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

  it('checkClaudeModel makes a one-token call to the chosen model', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock;
    await expect(checkClaudeModel('fake-key', 'claude-haiku-4-5')).resolves.toBeUndefined();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 1 });
  });

  it('checkClaudeModel throws with the HTTP status on a non-2xx response', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: async () => '' } as Response);
    await expect(checkClaudeModel('fake-key', 'claude-haiku-4-5')).rejects.toThrow(/HTTP 401/);
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
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ content: [] }) } as Response);
    await expect(
      generateClaudeText({ apiKey: 'k', model: 'claude-3', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(ClaudeApiError);
  });
});
