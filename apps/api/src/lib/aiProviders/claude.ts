/**
 * Claude client — real HTTP calls to Anthropic's Messages API, BYOK (the customer's own key,
 * decrypted per-call by the caller, never a WarmHawk-owned key). Thin, dependency-free `fetch`
 * wrapper, same rationale as `gemini.ts` — no `@anthropic-ai/sdk` dependency, so tests mock
 * `global.fetch` directly.
 */

const API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const VALIDATE_TIMEOUT_MS = 8_000;
const GENERATE_TIMEOUT_MS = 20_000;
const MAX_TOKENS = 1024;

export class ClaudeApiError extends Error {}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Near-zero-cost validation call — `GET /v1/models` lists models rather than generating a
 *  completion, so saving a key never burns a customer's own token quota. Same
 *  non-2xx-or-network-failure -> false convention as `validateGeminiKey`. */
export async function validateClaudeKey(apiKey: string): Promise<boolean> {
  const { signal, clear } = withTimeout(VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clear();
  }
}

/** Real Messages API call. Throws `ClaudeApiError` on any failure — same retry/fallback-belongs-
 *  to-the-caller convention as `generateGeminiText`. */
export async function generateClaudeText(params: {
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<string> {
  const { apiKey, model, prompt } = params;
  const { signal, clear } = withTimeout(GENERATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ClaudeApiError(`Claude messages call failed with HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = json.content?.find((block) => block.type === 'text')?.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw new ClaudeApiError('Claude messages call returned no usable text');
    }
    return text;
  } catch (err) {
    if (err instanceof ClaudeApiError) throw err;
    throw new ClaudeApiError(`Claude messages request failed: ${(err as Error).message}`);
  } finally {
    clear();
  }
}
