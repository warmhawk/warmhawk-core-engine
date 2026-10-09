/**
 * Warmup dashboard API — what the operator's Warmup page reads.
 *   GET  /warmup                       one row per mailbox: stage, day, health, 7-day counts
 *   GET  /warmup/:mailboxId/messages   the send log, newest first: `?page&pageSize&result&period`
 *   POST /warmup/:mailboxId/send-now   sends one warmup email right away ("Send test")
 * Pausing warmup for a mailbox is `PATCH /mailboxes/:id { warmupEnabled }`.
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type Prisma } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { parseChoice, parsePage, type PageQuery } from '../lib/pagination';
import { defaultWarmupDeps, getWarmupOverview, sendOneWarmup } from '../lib/warmup/engine';
import { loadPartnerPool, mailboxCanWarm } from '../lib/warmup/partners';

/** An older dashboard asks without `pageSize` and shows "last 50" — keep that default. */
const DEFAULT_MESSAGE_PAGE_SIZE = 50;

const RESULTS = [
  'inbox',
  'promotions',
  'spam',
  'moved',
  'missing',
  'bounced',
  'pending',
  'unchecked',
  'failed',
] as const;
type ResultFilter = (typeof RESULTS)[number];

const PERIODS = ['24h', '7d', '30d', 'all'] as const;
type PeriodFilter = (typeof PERIODS)[number];

const PERIOD_MS: Record<Exclude<PeriodFilter, 'all'>, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

/** `moved` is spam that warmup moved back to the inbox; `spam` includes it. */
const RESULT_WHERE: Record<ResultFilter, Prisma.WarmupMessageWhereInput> = {
  inbox: { placement: 'INBOX' },
  promotions: { placement: 'PROMOTIONS' },
  spam: { placement: 'SPAM' },
  moved: { rescued: true },
  missing: { placement: 'MISSING' },
  bounced: { placement: 'BOUNCED' },
  pending: { placement: 'PENDING' },
  unchecked: { placement: 'UNCHECKED' },
  failed: { placement: 'FAILED' },
};

interface MessagesQuery extends PageQuery {
  result?: string;
  period?: string;
}

export async function warmupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => getWarmupOverview());

  app.get<{ Params: { mailboxId: string }; Querystring: MessagesQuery }>(
    '/:mailboxId/messages',
    async (request, reply) => {
      const page = parsePage(request.query, DEFAULT_MESSAGE_PAGE_SIZE);
      if (!page.ok) return reply.code(400).send({ error: page.error });
      const result = parseChoice(request.query.result, RESULTS, 'result');
      if (!result.ok) return reply.code(400).send({ error: result.error });
      const period = parseChoice(request.query.period, PERIODS, 'period');
      if (!period.ok) return reply.code(400).send({ error: period.error });

      const mailbox = await prisma.mailbox.findUnique({
        where: { id: request.params.mailboxId },
        select: { id: true },
      });
      if (!mailbox) return reply.code(404).send({ error: 'Mailbox not found' });

      const where: Prisma.WarmupMessageWhereInput = {
        senderMailboxId: mailbox.id,
        ...(result.value ? RESULT_WHERE[result.value] : {}),
        ...(period.value && period.value !== 'all'
          ? { sentAt: { gte: new Date(Date.now() - PERIOD_MS[period.value]) } }
          : {}),
      };
      const [messages, total] = await Promise.all([
        prisma.warmupMessage.findMany({
          where,
          orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
          skip: page.value.skip,
          take: page.value.take,
          select: {
            id: true,
            recipientEmail: true,
            subject: true,
            sentAt: true,
            placement: true,
            foundFolder: true,
            rescued: true,
            checkedAt: true,
            error: true,
          },
        }),
        prisma.warmupMessage.count({ where }),
      ]);
      return { messages, total, page: page.value.page, pageSize: page.value.pageSize };
    },
  );

  app.post<{ Params: { mailboxId: string } }>('/:mailboxId/send-now', async (request, reply) => {
    const mailbox = await prisma.mailbox.findUnique({ where: { id: request.params.mailboxId } });
    if (!mailbox) return reply.code(404).send({ error: 'Mailbox not found' });
    if (!mailboxCanWarm(mailbox)) {
      return reply.code(422).send({
        error:
          mailbox.status === 'PAUSED'
            ? 'This mailbox is paused. Set it to Warm-up or Active first.'
            : 'This mailbox is not fully connected yet. Reconnect it, then try again.',
      });
    }
    const result = await sendOneWarmup(mailbox, await loadPartnerPool(), defaultWarmupDeps);
    if (result.status === 'no_partner') {
      return reply.code(409).send({
        error: 'Warmup needs somewhere to send. Add a second mailbox or a test inbox first.',
      });
    }
    if (result.status === 'failed') {
      return reply.code(502).send({ error: `Send failed: ${result.error}`, to: result.to });
    }
    return reply.code(201).send(result);
  });
}
