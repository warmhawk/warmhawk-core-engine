/**
 * Gemini client — real HTTP calls to Google's Generative Language API, BYOK (the customer's own
 * key, decrypted per-call by the caller, never a WarmHawk-owned key). Kept as a thin, dependency-
 * free `fetch` wrapper (no `@google/generative-ai` SDK) so `aiProviderClient.ts`'s tests can mock
 * `global.fetch` directly rather than needing to mock an SDK's internals — matches this repo's
 * existing convention of not depending on a provider SDK when a couple of REST calls will do.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const CHECK_TIMEOUT_MS = 15_000;
const GENERATE_TIMEOUT_MS = 20_000;

export class GeminiApiError extends Error {}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** The check run when a key is saved: one tiny `generateContent` on the model the customer picked,
 *  capped at a few output tokens. Listing models only proved the key exists — a free-tier key
 *  lists models it gets no quota for (429), so a key saved that way read "Configured" and then
 *  every send quietly went out as the backup text. Resolves on any 2xx (a capped reply with no
 *  text is still a yes); throws `GeminiApiError` with the HTTP status in the message otherwise, so
 *  `classifyAiFailure` reads it the same way it reads a failed send. */
export async function checkGeminiModel(apiKey: string, model: string): Promise<void> {
  const { signal, clear } = withTimeout(CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with OK.' }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new GeminiApiError(
        `Gemini key check failed with HTTP ${res.status}: ${detail.slice(0, 300)}`,
      );
    }
  } catch (err) {
    if (err instanceof GeminiApiError) throw err;
    throw new GeminiApiError(`Gemini key check request failed: ${(err as Error).message}`);
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
    const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      // In a header, not `?key=`, so the key never lands in a proxy's or Google's URL logs.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new GeminiApiError(
        `Gemini generateContent failed with HTTP ${res.status}: ${detail.slice(0, 300)}`,
      );
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
