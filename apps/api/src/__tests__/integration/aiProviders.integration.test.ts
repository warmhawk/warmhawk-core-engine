/**
 * Integration test for `POST /v1/ai-providers` against a REAL Postgres (docker-compose.test.yml).
 * Covers the save check found in the 10-05 campaign test: listing models passed a free Gemini key
 * for a model it gets no quota on, so the key read "Configured" while every send fell back to the
 * template. Saving now makes one capped call to the chosen model and says why it failed. `fetch` is
 * stubbed — tests never reach a live endpoint. Self-skips without DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { decrypt, loadEncryptionKey } from '../../lib/encryption';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('/v1/ai-providers save check (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;

  const save = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/ai-providers',
      headers: { authorization: `Bearer ${authToken}` },
      payload,
    });

  /** Stubs the one outbound check call per save. */
  function providerAnswers(...statuses: number[]) {
    const spy = vi.spyOn(global, 'fetch');
    for (const status of statuses) {
      spy.mockResolvedValueOnce(new Response(status === 200 ? '{}' : 'error', { status }));
    }
    return spy;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('a'.repeat(32)).toString('base64');
    app = await createApp();
    await app.ready();

    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.org', role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
  });

  afterEach(async () => {
    await prisma.aiProviderKey.deleteMany({ where: { provider: 'GEMINI' } });
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('saves the key after a working call to the chosen model', async () => {
    const fetchSpy = providerAnswers(200);
    const response = await save({
      provider: 'GEMINI',
      apiKey: 'test-gemini-key',
      model: 'gemini-3.5-flash-lite',
    });
    expect(response.statusCode).toBe(201);
    expect(String(fetchSpy.mock.calls[0][0])).toContain(
      '/models/gemini-3.5-flash-lite:generateContent',
    );
    const stored = await prisma.aiProviderKey.findUniqueOrThrow({ where: { provider: 'GEMINI' } });
    expect(stored.model).toBe('gemini-3.5-flash-lite');
  });

  it.each([
    [429, 'quota_exceeded', /no quota for gemini-3\.8-flash/],
    [404, 'model_unavailable', /can't use gemini-3\.8-flash/],
    [401, 'key_rejected', /didn't accept this API key/],
    [503, 'provider_error', /Couldn't reach Gemini/],
  ])('refuses the save on HTTP %i and says why (%s)', async (status, reason, message) => {
    providerAnswers(status);
    const response = await save({
      provider: 'GEMINI',
      apiKey: 'test-gemini-key',
      model: 'gemini-3.8-flash',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().reason).toBe(reason);
    expect(response.json().error).toMatch(message);
    expect(await prisma.aiProviderKey.count({ where: { provider: 'GEMINI' } })).toBe(0);
  });

  it('switches the model with a blank key, checking the saved key against the new model', async () => {
    providerAnswers(200, 200);
    await save({ provider: 'GEMINI', apiKey: 'test-gemini-key', model: 'gemini-3.5-flash-lite' });
    const response = await save({ provider: 'GEMINI', model: 'gemini-3.1-pro-preview' });
    expect(response.statusCode).toBe(201);
    const stored = await prisma.aiProviderKey.findUniqueOrThrow({ where: { provider: 'GEMINI' } });
    expect(stored.model).toBe('gemini-3.1-pro-preview');
    const key = loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
    expect(decrypt(stored.apiKeyEncrypted, key)).toBe('test-gemini-key');
  });

  it('keeps the old model when the saved key fails the new one', async () => {
    providerAnswers(200, 429);
    await save({ provider: 'GEMINI', apiKey: 'test-gemini-key', model: 'gemini-3.5-flash-lite' });
    const response = await save({ provider: 'GEMINI', model: 'gemini-3.8-flash' });
    expect(response.statusCode).toBe(422);
    const stored = await prisma.aiProviderKey.findUniqueOrThrow({ where: { provider: 'GEMINI' } });
    expect(stored.model).toBe('gemini-3.5-flash-lite');
  });

  it('asks for a key when none is saved and none was sent', async () => {
    const response = await save({ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('Paste an API key first');
  });
});
