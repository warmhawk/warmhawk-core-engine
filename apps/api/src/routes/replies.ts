/**
 * Reply records — new, V11 (Reply Management & Unified Inbox). This route serves
 * warmhawk-enterprise-operator's Unified Reply Inbox page (that dashboard has no Postgres access
 * of its own to core-engine's data — it calls this API via `CORE_ENGINE_API_URL`, per the
 * Containerization Model's "two packages are independently deployable... talk via
 * CORE_ENGINE_API_URL"). Dashboard-facing, guarded by the same JWT auth as the rest of this API's
 * management routes. The n8n reply-poll workflow's machine-to-machine endpoints (`GET /pending`,
 * `POST /`) live separately in `routes/internalReplies.ts`, mounted under `/internal/replies`.
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type ReplyClassification } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';

interface ListRepliesQuery {
  classification?: ReplyClassification;
  campaignId?: string;
  mailboxId?: string;
}

export async function repliesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get<{ Querystring: ListRepliesQuery }>('/', async (request) => {
    const { classification, campaignId, mailboxId } = request.query;
    return prisma.reply.findMany({
      where: {
        ...(classification ? { classification } : {}),
        ...(campaignId ? { campaignId } : {}),
        ...(mailboxId ? { mailboxId } : {}),
      },
      // `mailbox: { include: { domain: true } }`, not a flat `mailbox: true` — the operator's
      // Unified Reply Inbox filters by domain name (`reply.mailbox.domain.domainName`), which
      // needs the nested relation, not just the mailbox row.
      include: { lead: true, campaign: true, mailbox: { include: { domain: true } } },
      orderBy: { repliedAt: 'desc' },
    });
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
