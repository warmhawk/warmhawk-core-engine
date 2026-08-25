/**
 * Mailbox management — minimal CRUD. OAuth-connected mailboxes get their credentials populated
 * by `oauthCallback.ts`, not this route; this route creates the Mailbox row itself (so a
 * `mailboxId` exists to pass to `GET /oauth/:provider/authorize?mailboxId=`) and handles the
 * SMTP/IMAP-password fallback path directly (encrypting the password server-side before it's
 * ever persisted).
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type MailboxProvider } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { encrypt, loadEncryptionKey } from '../lib/encryption';

interface CreateMailboxBody {
  email: string;
  domainId: string;
  provider?: MailboxProvider;
  dailyCap?: number;
  smtpHost?: string;
  smtpPort?: number;
  imapHost?: string;
  imapPort?: number;
  authUsername?: string;
  authPassword?: string; // plaintext in transit over TLS only — encrypted immediately below
}

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
}

export async function mailboxesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => prisma.mailbox.findMany({ orderBy: { createdAt: 'desc' } }));

  app.post<{ Body: CreateMailboxBody }>('/', async (request, reply) => {
    const body = request.body;
    if (!body.email?.trim() || !body.domainId) {
      return reply.code(422).send({ error: 'email and domainId are required' });
    }

    const authPasswordEncrypted = body.authPassword
      ? encrypt(body.authPassword, encryptionKey())
      : undefined;

    const created = await prisma.mailbox.create({
      data: {
        email: body.email.trim().toLowerCase(),
        domainId: body.domainId,
        provider: body.provider ?? 'SMTP_CUSTOM',
        dailyCap: body.dailyCap ?? 25,
        smtpHost: body.smtpHost,
        smtpPort: body.smtpPort,
        imapHost: body.imapHost,
        imapPort: body.imapPort,
        authUsername: body.authUsername,
        authPasswordEncrypted,
      },
    });
    // Never echo the encrypted credential back, even to the authenticated caller who just set it.
    const { authPasswordEncrypted: _omit, oauthRefreshTokenEncrypted: _omit2, ...safe } = created;
    return reply.code(201).send(safe);
  });

  app.patch<{ Params: { id: string }; Body: { status?: string; dailyCap?: number } }>(
    '/:id',
    async (request, reply) => {
      const updated = await prisma.mailbox
        .update({ where: { id: request.params.id }, data: request.body as never })
        .catch(() => null);
      if (!updated) return reply.code(404).send({ error: 'Mailbox not found' });
      const { authPasswordEncrypted: _omit, oauthRefreshTokenEncrypted: _omit2, ...safe } = updated;
      return safe;
    },
  );

  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const deleted = await prisma.mailbox
      .delete({ where: { id: request.params.id } })
      .catch(() => null);
    if (!deleted) return reply.code(404).send({ error: 'Mailbox not found' });
    return reply.code(204).send();
  });
}
