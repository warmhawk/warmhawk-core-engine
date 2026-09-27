/**
 * Reply records — new, V11 (Reply Management & Unified Inbox). This route serves
 * the licensed dashboard's Unified Reply Inbox page (that dashboard has no Postgres access
 * of its own to core-engine's data — it calls this API via `CORE_ENGINE_API_URL`, per the
 * Containerization Model's "two packages are independently deployable... talk via
 * CORE_ENGINE_API_URL"). Dashboard-facing, guarded by the same JWT auth as the rest of this API's
 * management routes. The n8n reply-poll workflow's machine-to-machine endpoints (`GET /pending`,
 * `POST /`) live separately in `routes/internalReplies.ts`, mounted under `/internal/replies`.
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type Prisma, type ReplyClassification } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { parseChoice, parsePage, wantsPage, type PageQuery } from '../lib/pagination';

interface ListRepliesQuery extends PageQuery {
  classification?: ReplyClassification;
  campaignId?: string;
  mailboxId?: string;
  domainId?: string;
}

const CLASSIFICATIONS = [
  'INTERESTED',
  'NOT_INTERESTED',
  'OUT_OF_OFFICE',
  'AUTO_REPLY',
  'OPT_OUT',
  'UNCLASSIFIED',
] as const satisfies readonly ReplyClassification[];

export async function repliesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Newest first. With `?page`/`?pageSize` it returns `{ replies, total, page, pageSize }`;
   *  without them it returns the plain array it always has, for dashboards that predate paging. */
  app.get<{ Querystring: ListRepliesQuery }>('/', async (request, reply) => {
    const { campaignId, mailboxId, domainId } = request.query;
    const classification = parseChoice(request.query.classification, CLASSIFICATIONS, 'classification');
    if (!classification.ok) return reply.code(400).send({ error: classification.error });

    const where: Prisma.ReplyWhereInput = {
      ...(classification.value ? { classification: classification.value } : {}),
      ...(campaignId ? { campaignId } : {}),
      ...(mailboxId ? { mailboxId } : {}),
      ...(domainId ? { mailbox: { domainId } } : {}),
    };
    // `mailbox: { include: { domain: true } }`, not a flat `mailbox: true` — the operator's
    // Unified Reply Inbox shows the domain name (`reply.mailbox.domain.domainName`), which needs
    // the nested relation, not just the mailbox row.
    const include = { lead: true, campaign: true, mailbox: { include: { domain: true } } };
    const orderBy: Prisma.ReplyOrderByWithRelationInput[] = [{ repliedAt: 'desc' }, { id: 'desc' }];

    if (!wantsPage(request.query)) {
      return prisma.reply.findMany({ where, include, orderBy });
    }
    const page = parsePage(request.query);
    if (!page.ok) return reply.code(400).send({ error: page.error });
    const [replies, total] = await Promise.all([
      prisma.reply.findMany({ where, include, orderBy, skip: page.value.skip, take: page.value.take }),
      prisma.reply.count({ where }),
    ]);
    return { replies, total, page: page.value.page, pageSize: page.value.pageSize };
  });

  app.patch<{ Params: { id: string }; Body: { classification?: ReplyClassification } }>(
    '/:id',
    async (request, reply) => {
      const { classification } = request.body;
      if (!classification) return reply.code(422).send({ error: 'classification is required' });
      const updated = await prisma.reply
        .update({
          where: { id: request.params.id },
          data: { classification, classifiedAt: new Date() },
        })
        .catch(() => null);
      if (!updated) return reply.code(404).send({ error: 'Reply not found' });
      return updated;
    },
  );
}
