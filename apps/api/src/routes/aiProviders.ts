/**
 * BYOK AI provider key management — Phase 3. `GET/POST/DELETE /ai-providers` per the spec: list
 * (masked key), save (encrypt + one capped call to the chosen model before persisting), delete
 * (falls back to unpersonalized sends, doesn't break the campaign — enforced by
 * `Campaign.aiProvider` being nullable, not by anything in this route).
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type AiProvider } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { encrypt, decrypt, loadEncryptionKey, maskSecret } from '../lib/encryption';
import { checkProviderKey, type AiFallbackReason } from '../lib/aiProviderClient';

interface SaveProviderBody {
  provider?: AiProvider;
  apiKey?: string;
  model?: string;
}

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
}

const PROVIDER_NAME: Record<AiProvider, string> = { GEMINI: 'Gemini', CLAUDE: 'Claude' };

/** What the save form shows when the check call fails — one sentence on what to do next. */
function checkFailedMessage(provider: AiProvider, model: string, reason: AiFallbackReason): string {
  const name = PROVIDER_NAME[provider];
  switch (reason) {
    case 'key_rejected':
      return `${name} didn't accept this API key. Copy it again from your ${name} account and paste it here.`;
    case 'model_unavailable':
      return `This key can't use ${model}. Pick another model.`;
    case 'quota_exceeded':
      return `${name} says this key has no quota for ${model} right now. Free keys don't cover every model: pick another model, or turn on billing for the key.`;
    default:
      return `Couldn't reach ${name} to check the key. Try again in a minute.`;
  }
}

export async function aiProvidersRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => {
    const keys = await prisma.aiProviderKey.findMany();
    const key = encryptionKey();
    return keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      model: k.model,
      isActive: k.isActive,
      maskedKey: maskSecret(decrypt(k.apiKeyEncrypted, key)),
      createdAt: k.createdAt,
      updatedAt: k.updatedAt,
    }));
  });

  app.post<{ Body: SaveProviderBody }>('/', async (request, reply) => {
    const { provider, model } = request.body;
    if (!provider || !model) {
      return reply.code(422).send({ error: 'provider and model are required' });
    }

    // A blank key keeps the saved one, so switching models doesn't mean pasting the key again.
    let apiKey = request.body.apiKey?.trim();
    if (!apiKey) {
      const existing = await prisma.aiProviderKey.findUnique({ where: { provider } });
      if (!existing) return reply.code(422).send({ error: 'Paste an API key first' });
      apiKey = decrypt(existing.apiKeyEncrypted, encryptionKey());
    }

    const check = await checkProviderKey(provider, apiKey, model);
    if (!check.ok) {
      return reply
        .code(422)
        .send({ error: checkFailedMessage(provider, model, check.reason), reason: check.reason });
    }

    const apiKeyEncrypted = encrypt(apiKey, encryptionKey());

    const saved = await prisma.aiProviderKey.upsert({
      where: { provider },
      create: { provider, apiKeyEncrypted, model, isActive: true },
      update: { apiKeyEncrypted, model, isActive: true },
    });

    return reply.code(201).send({
      id: saved.id,
      provider: saved.provider,
      model: saved.model,
      isActive: saved.isActive,
      maskedKey: maskSecret(apiKey),
    });
  });

  app.delete<{ Params: { provider: string } }>('/:provider', async (request, reply) => {
    const provider = request.params.provider as AiProvider;
    const deleted = await prisma.aiProviderKey.delete({ where: { provider } }).catch(() => null);
    if (!deleted) return reply.code(404).send({ error: 'No key configured for this provider' });
    // Falls back to unpersonalized sends — Campaign.aiProvider is nullable and the send pipeline
    // already treats a missing/inactive key as "send template as-is," not a hard failure.
    return reply.code(204).send();
  });
}
