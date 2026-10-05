/**
 * The do-not-contact list, for the operator's Settings → Blocked list page.
 *
 * Every way onto the list goes through `lib/suppression.ts`, so a block here also stops any lead
 * row already carrying the address. An unblock only removes the list entry (see
 * `unsuppressEmail`).
 *
 * Unblock is `POST /unblock` with the address in the body, not `DELETE /:email`: the operator's
 * backend proxy sends no body on DELETE, and an address in the path needs encoding every client
 * gets right. Export returns JSON rather than CSV for the same proxy reason — it always answers
 * with JSON, so the dashboard builds the file.
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type Prisma } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { parsePage, type PageQuery } from '../lib/pagination';
import { EMAIL_REGEX } from '../lib/leadIngest';
import { suppressEmails, unsuppressEmail } from '../lib/suppression';

/** A big ESP export is a few thousand rows; anything past this is better split than held in one
 *  request. */
export const MAX_IMPORT = 10_000;

interface ListQuery extends PageQuery {
  q?: string;
}

const normalize = (email: string) => email.trim().toLowerCase();

export async function suppressionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Newest first, always paged: `{ entries, total, page, pageSize }`. `?q=` matches part of an
   *  address. */
  app.get<{ Querystring: ListQuery }>('/', async (request, reply) => {
    const page = parsePage(request.query);
    if (!page.ok) return reply.code(400).send({ error: page.error });
    const q = request.query.q?.trim().toLowerCase();
    const where: Prisma.SuppressionEntryWhereInput = q ? { email: { contains: q } } : {};
    const orderBy: Prisma.SuppressionEntryOrderByWithRelationInput[] = [
      { createdAt: 'desc' },
      { id: 'desc' },
    ];
    const [entries, total] = await Promise.all([
      prisma.suppressionEntry.findMany({
        where,
        orderBy,
        skip: page.value.skip,
        take: page.value.take,
      }),
      prisma.suppressionEntry.count({ where }),
    ]);
    return { entries, total, page: page.value.page, pageSize: page.value.pageSize };
  });

  /** Every entry, oldest first, for the dashboard's CSV download. */
  app.get('/export', async () => {
    const entries = await prisma.suppressionEntry.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { email: true, source: true, reason: true, createdAt: true },
    });
    return { entries };
  });

  /** `{ emails }` — a pasted list or a CSV column. Bad lines are counted, not fatal, so one typo
   *  doesn't throw away a 5,000-row list. */
  app.post<{ Body: { emails?: unknown } }>('/import', async (request, reply) => {
    const raw = request.body?.emails;
    if (!Array.isArray(raw) || raw.length === 0) {
      return reply.code(422).send({ error: 'emails must be a non-empty list of addresses' });
    }
    if (raw.length > MAX_IMPORT) {
      return reply.code(422).send({
        error: `At most ${MAX_IMPORT.toLocaleString('en-US')} addresses per import — split the list`,
      });
    }

    const valid = new Set<string>();
    let invalid = 0;
    for (const item of raw) {
      const email = typeof item === 'string' ? normalize(item) : '';
      if (EMAIL_REGEX.test(email)) valid.add(email);
      else if (email !== '') invalid += 1;
    }
    const emails = [...valid];
    const { added } = await suppressEmails(emails, {
      source: 'import',
      reason: 'Imported do-not-contact list',
    });
    return { added, alreadyBlocked: emails.length - added, invalid };
  });

  app.post<{ Body: { email?: unknown } }>('/unblock', async (request, reply) => {
    const email = typeof request.body?.email === 'string' ? normalize(request.body.email) : '';
    if (!email) return reply.code(422).send({ error: 'email is required' });
    if (!(await unsuppressEmail(email)))
      return reply.code(404).send({ error: `${email} isn't blocked` });
    return { email, unblocked: true };
  });
}
