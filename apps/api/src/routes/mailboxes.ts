/**
 * Mailbox management — minimal CRUD. OAuth-connected mailboxes get their credentials populated
 * by `oauthCallback.ts`, not this route; this route creates the Mailbox row itself (so a
 * `mailboxId` exists to pass to `GET /oauth/:provider/authorize?mailboxId=`) and handles the
 * SMTP/IMAP-password fallback path directly (encrypting the password server-side before it's
 * ever persisted).
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type MailboxProvider, type MailboxStatus } from '@warmhawk/db';
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
  senderName?: string | null;
}

const SENDER_NAME_MAX = 80;

/** The From display name. Blank clears it (back to the address's local part); a CR/LF would let
 *  a caller inject extra headers into every send, so those are refused outright. */
function parseSenderName(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'senderName must be a string' };
  if (/[\r\n]/.test(value)) return { ok: false, error: 'senderName must be a single line' };
  const trimmed = value.trim();
  if (trimmed.length > SENDER_NAME_MAX) {
    return { ok: false, error: `senderName must be ${SENDER_NAME_MAX} characters or fewer` };
  }
  return { ok: true, value: trimmed || null };
}

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
}

export async function mailboxesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => {
    const mailboxes = await prisma.mailbox.findMany({ orderBy: { createdAt: 'desc' } });
    // Bug fix: unlike POST/PATCH below, this previously returned the full row, including
    // `authPasswordEncrypted`/`oauthRefreshTokenEncrypted` — leaking encrypted credential
    // material to any authenticated caller. Apply the same redaction POST/PATCH already use.
    return mailboxes.map(({ authPasswordEncrypted: _omit, oauthRefreshTokenEncrypted: _omit2, ...safe }) => safe);
  });

  app.post<{ Body: CreateMailboxBody }>('/', async (request, reply) => {
    const body = request.body;
    if (!body.email?.trim() || !body.domainId) {
      return reply.code(422).send({ error: 'email and domainId are required' });
    }
    // A bare "sales" used to be saved as-is, then sent to Google/Microsoft as the sign-in hint and
    // dead-ended there. Only a complete address can ever connect.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
      return reply
        .code(422)
        .send({ error: 'Enter the full mailbox address, like sales@yourdomain.com' });
    }
    const senderName = body.senderName === undefined ? { ok: true as const, value: null } : parseSenderName(body.senderName);
    if (!senderName.ok) return reply.code(422).send({ error: senderName.error });

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
        senderName: senderName.value,
      },
    });
    // Never echo the encrypted credential back, even to the authenticated caller who just set it.
    const { authPasswordEncrypted: _omit, oauthRefreshTokenEncrypted: _omit2, ...safe } = created;
    return reply.code(201).send(safe);
  });

  app.patch<{
    Params: { id: string };
    Body: { status?: MailboxStatus; dailyCap?: number; warmupEnabled?: boolean; senderName?: string | null };
  }>(
    '/:id',
    async (request, reply) => {
      // Bug fix: `data: request.body as never` passed the raw request body straight to Prisma —
      // the `Body` type above was compile-time-only decoration with no runtime enforcement (no
      // Fastify JSON schema on this route), so any authenticated caller could PATCH fields well
      // outside this route's intended "status/dailyCap only" contract: `provider`,
      // `oauthConnectedAt`, `oauthRefreshTokenEncrypted`, even `authPasswordEncrypted`. Whitelist
      // exactly the fields this route is meant to expose (status, dailyCap, warmupEnabled,
      // senderName).
      const data: { status?: MailboxStatus; dailyCap?: number; warmupEnabled?: boolean; senderName?: string | null } = {};
      if (request.body.status !== undefined) data.status = request.body.status;
      if (request.body.dailyCap !== undefined) data.dailyCap = request.body.dailyCap;
      if (request.body.warmupEnabled !== undefined) {
        if (typeof request.body.warmupEnabled !== 'boolean') {
          return reply.code(400).send({ error: 'warmupEnabled must be true or false' });
        }
        data.warmupEnabled = request.body.warmupEnabled;
      }
      if (request.body.senderName !== undefined) {
        const senderName = parseSenderName(request.body.senderName);
        if (!senderName.ok) return reply.code(422).send({ error: senderName.error });
        data.senderName = senderName.value;
      }

      const updated = await prisma.mailbox
        .update({ where: { id: request.params.id }, data })
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
