/**
 * BYOK AI provider key management — Phase 3. `GET/POST/DELETE /ai-providers` per the spec: list
 * (masked key), save (encrypt + one lightweight validation call before persisting), delete
 * (falls back to unpersonalized sends, doesn't break the campaign — enforced by
 * `Campaign.aiProvider` being nullable, not by anything in this route).
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type AiProvider } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { encrypt, decrypt, loadEncryptionKey, maskSecret } from '../lib/encryption';
import { validateProviderKey } from '../lib/aiProviderClient';

interface SaveProviderBody {
  provider?: AiProvider;
  apiKey?: string;
  model?: string;
}

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
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
    const { provider, apiKey, model } = request.body;
    if (!provider || !apiKey || !model) {
      return reply.code(422).send({ error: 'provider, apiKey, and model are required' });
    }

    const isValid = await validateProviderKey(provider, apiKey);
    if (!isValid) {
      return reply.code(422).send({ error: 'The provided API key failed validation' });
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
