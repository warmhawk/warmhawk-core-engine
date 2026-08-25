/**
 * Gemini client — real HTTP calls to Google's Generative Language API, BYOK (the customer's own
 * key, decrypted per-call by the caller, never a WarmHawk-owned key). Kept as a thin, dependency-
 * free `fetch` wrapper (no `@google/generative-ai` SDK) so `aiProviderClient.ts`'s tests can mock
 * `global.fetch` directly rather than needing to mock an SDK's internals — matches this repo's
 * existing convention of not depending on a provider SDK when a couple of REST calls will do.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const VALIDATE_TIMEOUT_MS = 8_000;
const GENERATE_TIMEOUT_MS = 20_000;

export class GeminiApiError extends Error {}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Near-zero-cost validation call — lists models rather than generating content, so saving a key
 *  never burns a customer's own token quota. Any non-2xx (bad key, revoked, wrong project) is
 *  treated as invalid; a network-level failure is also treated as invalid rather than thrown,
 *  since "can we confirm this key works right now" is the only question this function answers. */
export async function validateGeminiKey(apiKey: string): Promise<boolean> {
  const { signal, clear } = withTimeout(VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/models?key=${encodeURIComponent(apiKey)}`, { signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clear();
  }
}

/** Real `generateContent` call. Throws `GeminiApiError` on any failure (non-2xx, timeout,
 *  malformed response) — the caller (`aiProviderClient.ts` / `routes/internalAi.ts`) owns the
 *  retry-once-then-fall-back-to-template policy, not this file. */
export async function generateGeminiText(params: {
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<string> {
  const { apiKey, model, prompt } = params;
  const { signal, clear } = withTimeout(GENERATE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal,
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new GeminiApiError(`Gemini generateContent failed with HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw new GeminiApiError('Gemini generateContent returned no usable text');
    }
    return text;
  } catch (err) {
    if (err instanceof GeminiApiError) throw err;
    throw new GeminiApiError(`Gemini generateContent request failed: ${(err as Error).message}`);
  } finally {
    clear();
  }
}
