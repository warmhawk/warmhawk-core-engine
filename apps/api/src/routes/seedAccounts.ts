/**
 * Seed account management — Seed-Inbox Placement Test (Guardrails, V12, option (c)). Minimal CRUD
 * mirroring `mailboxes.ts`'s shape: this is genuinely customer/founder-configured (Tier 0 has no
 * dashboard, so this is a direct-API-only setup step, same as everything else Tier 0 configures),
 * and the encrypted IMAP config is never echoed back once set.
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type SeedAccountProvider } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { encryptSeedImapConfig } from '../lib/seedAccounts';

interface CreateSeedAccountBody {
  provider: SeedAccountProvider;
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  isActive?: boolean;
}

interface UpdateSeedAccountBody {
  isActive?: boolean;
}

export async function seedAccountsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => {
    const accounts = await prisma.seedAccount.findMany({ orderBy: { createdAt: 'desc' } });
    return accounts.map(({ imapConfigEncrypted: _omit, ...safe }) => safe);
  });

  app.post<{ Body: CreateSeedAccountBody }>('/', async (request, reply) => {
    const { provider, emailAddress, imapHost, imapPort, imapUsername, imapPassword, isActive } =
      request.body;
    if (!provider || !emailAddress?.trim() || !imapHost || !imapPort || !imapUsername || !imapPassword) {
      return reply.code(422).send({
        error: 'provider, emailAddress, imapHost, imapPort, imapUsername and imapPassword are required',
      });
    }

    const imapConfigEncrypted = encryptSeedImapConfig({
      host: imapHost,
      port: imapPort,
      username: imapUsername,
      password: imapPassword,
    });

    const created = await prisma.seedAccount.create({
      data: {
        provider,
        emailAddress: emailAddress.trim().toLowerCase(),
        imapConfigEncrypted,
        isActive: isActive ?? true,
      },
    });
    const { imapConfigEncrypted: _omit, ...safe } = created;
    return reply.code(201).send(safe);
  });

  app.patch<{ Params: { id: string }; Body: UpdateSeedAccountBody }>(
    '/:id',
    async (request, reply) => {
      const updated = await prisma.seedAccount
        .update({ where: { id: request.params.id }, data: { isActive: request.body.isActive } })
        .catch(() => null);
      if (!updated) return reply.code(404).send({ error: 'Seed account not found' });
      const { imapConfigEncrypted: _omit, ...safe } = updated;
      return safe;
    },
  );

  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const deleted = await prisma.seedAccount
      .delete({ where: { id: request.params.id } })
      .catch(() => null);
    if (!deleted) return reply.code(404).send({ error: 'Seed account not found' });
    return reply.code(204).send();
  });
}
