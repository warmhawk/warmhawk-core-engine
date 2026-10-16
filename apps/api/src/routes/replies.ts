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
import { applyReplyOutcome } from '../lib/replyOutcome';

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
  'LEFT_COMPANY',
  'OPT_OUT',
  'UNCLASSIFIED',
  'BOUNCED',
] as const satisfies readonly ReplyClassification[];

/** The labels that leave something for the user to do. Every other label WarmHawk already acted
 *  on: the sequence stopped, the address blocked, or the lead marked bounced. */
export const WAITING_CLASSIFICATIONS = [
  'INTERESTED',
  'UNCLASSIFIED',
] as const satisfies readonly ReplyClassification[];

/** A reply still waiting on the user, for the dashboard's sidebar count. */
const WAITING: Prisma.ReplyWhereInput = {
  classification: { in: [...WAITING_CLASSIFICATIONS] },
  handledAt: null,
};

type ReplyRow = { leadId: string; mailboxId: string; repliedAt: Date };

/**
 * When the email each reply answers went out: the latest send to that lead from that mailbox at or
 * before the reply. Only rows with a provider Message-ID count, so a send the server refused isn't
 * shown as sent. One query for the whole page. `null` when no such send is on record.
 */
async function withSentAt<T extends ReplyRow>(
  replies: T[],
): Promise<(T & { sentAt: Date | null })[]> {
  if (replies.length === 0) return [];
  const sends = await prisma.executionLog.findMany({
    where: {
      leadId: { in: [...new Set(replies.map((r) => r.leadId))] },
      providerMessageId: { not: null },
    },
    select: { leadId: true, mailboxId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return replies.map((r) => ({
    ...r,
    sentAt:
      sends.find(
        (s) => s.leadId === r.leadId && s.mailboxId === r.mailboxId && s.createdAt <= r.repliedAt,
      )?.createdAt ?? null,
  }));
}

export async function repliesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Newest first. With `?page`/`?pageSize` it returns `{ replies, total, page, pageSize }`;
   *  without them it returns the plain array it always has, for dashboards that predate paging.
   *  Each reply carries `sentAt`, when the email it answers was sent (see `withSentAt`). */
  app.get<{ Querystring: ListRepliesQuery }>('/', async (request, reply) => {
    const { campaignId, mailboxId, domainId } = request.query;
    const classification = parseChoice(
      request.query.classification,
      CLASSIFICATIONS,
      'classification',
    );
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
      return withSentAt(await prisma.reply.findMany({ where, include, orderBy }));
    }
    const page = parsePage(request.query);
    if (!page.ok) return reply.code(400).send({ error: page.error });
    const [replies, total] = await Promise.all([
      prisma.reply.findMany({
        where,
        include,
        orderBy,
        skip: page.value.skip,
        take: page.value.take,
      }),
      prisma.reply.count({ where }),
    ]);
    return {
      replies: await withSentAt(replies),
      total,
      page: page.value.page,
      pageSize: page.value.pageSize,
    };
  });

  /** How many replies are waiting on the user: `{ count }`. */
  app.get('/waiting-count', async () => ({ count: await prisma.reply.count({ where: WAITING }) }));

  /** Relabel a reply (`classification`), or mark it dealt with or not (`handled`). */
  app.patch<{
    Params: { id: string };
    Body: { classification?: ReplyClassification; handled?: boolean };
  }>('/:id', async (request, reply) => {
    const { classification, handled } = request.body ?? {};
    if (!classification && typeof handled !== 'boolean') {
      return reply.code(422).send({ error: 'classification or handled is required' });
    }
    const updated = await prisma.reply
      .update({
        where: { id: request.params.id },
        data: {
          ...(classification ? { classification, classifiedAt: new Date() } : {}),
          ...(typeof handled === 'boolean' ? { handledAt: handled ? new Date() : null } : {}),
        },
      })
      .catch(() => null);
    if (!updated) return reply.code(404).send({ error: 'Reply not found' });
    // The lead follows the new label: relabelled an away notice, its follow-ups start again;
    // relabelled a real answer, they stop.
    if (classification) await applyReplyOutcome(updated.id);
    return updated;
  });
}
