/**
 * Campaign management — minimal CRUD backing the Tier 0 direct-API surface (docs/quickstart.md's
 * "create a campaign" step) and the fields the rest of this repo's guardrails/AI/reply features
 * hang off of (`aiProvider`, `template`, `unsubscribeUrlTemplate`, `bounceRateThreshold`).
 *
 * Content-quality wiring (Guardrails, V11): `scoreContent`/spintax validation existed as real,
 * unit-tested logic in `lib/spamScore.ts`/`lib/spintax.ts` with zero production callers before
 * this pass — spec requires them to run "on save (not just before send)". Spintax syntax is a
 * hard validation (malformed `{...}` groups would break rendering at send time, so create/update
 * reject it); the spam-word score is advisory, computed on every save and returned alongside the
 * campaign so the dashboard's Content Quality tab can surface it, never a hard block (a heuristic
 * score shouldn't unconditionally veto a legitimate campaign).
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type AiProvider, type CampaignStatus } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { scoreContent, type SpamScoreResult } from '../lib/spamScore';
import { listSpintaxGroups, SpintaxParseError } from '../lib/spintax';

interface CreateCampaignBody {
  name: string;
  aiPromptTemplate: string;
  template?: string;
  aiProvider?: AiProvider;
  unsubscribeUrlTemplate?: string;
}

interface UpdateCampaignBody {
  name?: string;
  status?: CampaignStatus;
  template?: string;
  aiPromptTemplate?: string;
  aiProvider?: AiProvider | null;
  unsubscribeUrlTemplate?: string;
  bounceRateThreshold?: number;
  /** Reset-only in practice — the breaker (see `lib/mailSender.ts`) is the only writer that ever
   *  sets this `true`; a dashboard "resume" action is the only legitimate caller setting it back
   *  to `false` once the underlying list-quality issue has been addressed. */
  pausedForBounceRate?: boolean;
}

interface ContentQuality {
  spamScore: SpamScoreResult;
  spintaxGroupCount: number;
}

/** Throws on unbalanced spintax (surfaced by the route as a 422); returns the computed
 *  content-quality metadata otherwise. `template` is the only free-text content field this Tier 0
 *  API models today — there is no separate subject-line field on `Campaign`. */
function evaluateContentQuality(template: string | undefined | null): ContentQuality {
  const content = template ?? '';
  const spintaxGroupCount = content ? listSpintaxGroups(content).length : 0;
  return { spamScore: scoreContent(content), spintaxGroupCount };
}

export async function campaignsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** List view — extended with per-campaign send/reply/domain aggregates so the dashboard's
   *  Campaigns tab (leads/sent/replies/domains/last-activity columns) doesn't need N follow-up
   *  requests. Computed via `_count` (leads, replies) and two grouped `ExecutionLog` queries
   *  (distinct domains reached, most recent send) rather than loading every related row. */
  app.get('/', async () => {
    const campaigns = await prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { leads: true, replies: true } },
      },
    });

    const campaignIds = campaigns.map((c) => c.id);
    const [sentCounts, lastActivity, domainCounts] = await Promise.all([
      campaignIds.length
        ? prisma.executionLog.groupBy({
            by: ['campaignId'],
            where: { campaignId: { in: campaignIds }, status: 'SENT' },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      campaignIds.length
        ? prisma.executionLog.groupBy({
            by: ['campaignId'],
            where: { campaignId: { in: campaignIds } },
            _max: { createdAt: true },
          })
        : Promise.resolve([]),
      campaignIds.length
        ? prisma.executionLog.findMany({
            where: { campaignId: { in: campaignIds }, status: 'SENT' },
            select: { campaignId: true, mailbox: { select: { domainId: true } } },
            distinct: ['campaignId', 'mailboxId'],
          })
        : Promise.resolve([]),
    ]);

    const sentByCampaign = new Map(sentCounts.map((row) => [row.campaignId, row._count._all]));
    const lastActivityByCampaign = new Map(
      lastActivity.map((row) => [row.campaignId, row._max.createdAt]),
    );
    const domainsByCampaign = new Map<string, Set<string>>();
    for (const row of domainCounts) {
      if (!row.campaignId || !row.mailbox?.domainId) continue;
      const set = domainsByCampaign.get(row.campaignId) ?? new Set<string>();
      set.add(row.mailbox.domainId);
      domainsByCampaign.set(row.campaignId, set);
    }

    return campaigns.map((campaign) => ({
      ...campaign,
      leadsCount: campaign._count.leads,
      repliesCount: campaign._count.replies,
      sentCount: sentByCampaign.get(campaign.id) ?? 0,
      domainsCount: domainsByCampaign.get(campaign.id)?.size ?? 0,
      lastActivityAt: lastActivityByCampaign.get(campaign.id) ?? null,
      _count: undefined,
    }));
  });

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const campaign = await prisma.campaign.findUnique({ where: { id: request.params.id } });
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
    return campaign;
  });

  app.post<{ Body: CreateCampaignBody }>('/', async (request, reply) => {
    const { name, aiPromptTemplate, template, aiProvider, unsubscribeUrlTemplate } = request.body;
    if (!name?.trim()) return reply.code(422).send({ error: 'name is required' });

    let contentQuality: ContentQuality;
    try {
      contentQuality = evaluateContentQuality(template);
    } catch (err) {
      if (err instanceof SpintaxParseError) {
        return reply.code(422).send({ error: `Invalid spintax in template: ${err.message}` });
      }
      throw err;
    }

    const created = await prisma.campaign.create({
      data: {
        name: name.trim(),
        aiPromptTemplate: aiPromptTemplate ?? '',
        template,
        aiProvider,
        unsubscribeUrlTemplate,
      },
    });
    return reply.code(201).send({ ...created, contentQuality });
  });

  app.patch<{ Params: { id: string }; Body: UpdateCampaignBody }>(
    '/:id',
    async (request, reply) => {
      let contentQuality: ContentQuality | undefined;
      if (request.body.template !== undefined) {
        try {
          contentQuality = evaluateContentQuality(request.body.template);
        } catch (err) {
          if (err instanceof SpintaxParseError) {
            return reply.code(422).send({ error: `Invalid spintax in template: ${err.message}` });
          }
          throw err;
        }
      }

      const updated = await prisma.campaign
        .update({ where: { id: request.params.id }, data: request.body })
        .catch(() => null);
      if (!updated) return reply.code(404).send({ error: 'Campaign not found' });
      return contentQuality ? { ...updated, contentQuality } : updated;
    },
  );

  /** `POST /v1/campaigns/:id/launch` (spec) — the one dedicated "go live" action, distinct from
   *  the generic `PATCH /:id` status setter: refuses to launch a campaign that's missing the
   *  CAN-SPAM-required unsubscribe template (the same gate `sendCompliance.ts` enforces per-send,
   *  applied here as an up-front check so a customer finds out at launch time, not on the first
   *  failed send) or that's still paused for a bounce-rate trip that hasn't been resolved. */
  app.post<{ Params: { id: string } }>('/:id/launch', async (request, reply) => {
    const campaign = await prisma.campaign.findUnique({ where: { id: request.params.id } });
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
    if (!campaign.unsubscribeUrlTemplate?.trim()) {
      return reply
        .code(422)
        .send({ error: 'unsubscribeUrlTemplate is required before a campaign can launch' });
    }
    if (campaign.pausedForBounceRate) {
      return reply.code(422).send({
        error: 'This campaign is paused for an elevated bounce rate — resolve before launching',
      });
    }
    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'ACTIVE' },
    });
    return updated;
  });

  /** `POST /v1/campaigns/:id/pause` (spec) — dedicated pause action, the counterpart to launch. */
  app.post<{ Params: { id: string } }>('/:id/pause', async (request, reply) => {
    const updated = await prisma.campaign
      .update({ where: { id: request.params.id }, data: { status: 'PAUSED' } })
      .catch(() => null);
    if (!updated) return reply.code(404).send({ error: 'Campaign not found' });
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    // Archive, not hard-delete — GDPR erasure is per-lead (`DELETE /leads/erase`), a campaign
    // itself isn't personal data.
    const updated = await prisma.campaign
      .update({ where: { id: request.params.id }, data: { status: 'ARCHIVED' } })
      .catch(() => null);
    if (!updated) return reply.code(404).send({ error: 'Campaign not found' });
    return reply.code(204).send();
  });
}
