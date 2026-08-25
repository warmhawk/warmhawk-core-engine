/**
 * Internal-only mailbox listing — `GET /internal/mailboxes/active`. The n8n `reply-poll` scheduled
 * workflow needs to enumerate which mailboxes to poll for replies via `/imap/search`, but the only
 * pre-existing mailbox listing route (`GET /mailboxes`) is dashboard-JWT-guarded (`requireAuth`),
 * which n8n has no way to obtain — n8n's machine-to-machine calls all use the shared callback
 * secret instead (see `requireCallbackSecret`, `/internal/ai/*`, `/imap/*`). This is a genuinely
 * new, minimal, internal-only route closing that gap: it returns only the `id`/`email` a polling
 * workflow needs, never credentials.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { requireCallbackSecret } from '../lib/requireCallbackSecret';

export async function internalMailboxesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCallbackSecret);

  /** Every mailbox not explicitly PAUSED — WARMUP mailboxes still receive replies worth polling
   *  for (e.g. a reply arriving mid-warmup), only PAUSED is excluded. */
  app.get('/active', async () => {
    const mailboxes = await prisma.mailbox.findMany({
      where: { status: { not: 'PAUSED' } },
      select: { id: true, email: true },
      orderBy: { email: 'asc' },
    });
    return { mailboxes };
  });
}
