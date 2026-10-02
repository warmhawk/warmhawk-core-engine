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
import { prisma, type AiProvider, type CampaignAiMode, type CampaignStatus } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { scoreContent, type SpamScoreResult } from '../lib/spamScore';
import { listSpintaxGroups, SpintaxParseError } from '../lib/spintax';
import { composeCampaignEmail, resolveSenderName, type ComposeCampaign } from '../lib/composeCampaignEmail';
import { appendCanSpamFooter, resolveUnsubscribeUrl } from '../lib/sendCompliance';
import { hostedUnsubscribeUrl } from '../lib/unsubscribeToken';

interface CreateCampaignBody {
  name: string;
  aiPromptTemplate: string;
  template?: string;
  subject?: string | null;
  aiProvider?: AiProvider;
  aiMode?: CampaignAiMode;
  aiWritesSubject?: boolean;
  unsubscribeUrlTemplate?: string;
}

interface UpdateCampaignBody {
  name?: string;
  status?: CampaignStatus;
  template?: string;
  subject?: string | null;
  aiPromptTemplate?: string;
  aiProvider?: AiProvider | null;
  aiMode?: CampaignAiMode;
  aiWritesSubject?: boolean;
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
 *  content-quality metadata otherwise. The subject is scored with the body — spam filters read
 *  both — and its spintax is validated the same way. */
function evaluateContentQuality(template: string | undefined | null, subject?: string | null): ContentQuality {
  const content = template ?? '';
  const spintaxGroupCount = content ? listSpintaxGroups(content).length : 0;
  if (subject) listSpintaxGroups(subject);
  return { spamScore: scoreContent(subject ? `${subject}\n${content}` : content), spintaxGroupCount };
}

const AI_MODES: CampaignAiMode[] = ['PERSONALIZE', 'PROMPT'];
const STANDARD_FIELDS = ['firstName', 'lastName', 'company', 'email', 'senderName'];
const SAMPLE_LEAD = {
  email: 'dana@acme.example',
  firstName: 'Dana',
  lastName: 'Reyes',
  company: 'Acme Logistics',
  customFields: { title: 'Head of Operations', city: 'Denver' },
};

/** The new compose fields share one check between create and update; `null` is a valid subject
 *  (clears it back to the first-line rule). Returns an error message, or null when valid. */
function composeFieldsError(body: { subject?: unknown; aiMode?: unknown; aiWritesSubject?: unknown }): string | null {
  if (body.subject !== undefined && body.subject !== null && typeof body.subject !== 'string') {
    return 'subject must be a string';
  }
  if (typeof body.subject === 'string' && body.subject.length > 500) return 'subject is too long';
  if (body.aiMode !== undefined && !AI_MODES.includes(body.aiMode as CampaignAiMode)) {
    return 'aiMode must be PERSONALIZE or PROMPT';
  }
  if (body.aiWritesSubject !== undefined && typeof body.aiWritesSubject !== 'boolean') {
    return 'aiWritesSubject must be true or false';
  }
  return null;
}

/** `{{name}}` tokens in the given texts, de-duplicated case-insensitively (merge-field filling is
 *  case-insensitive too), keeping the first spelling seen. */
function mergeTokens(texts: string[]): string[] {
  const seen = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
      if (!seen.has(match[1].toLowerCase())) seen.set(match[1].toLowerCase(), match[1]);
    }
  }
  return [...seen.values()];
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
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
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [sentCounts, lastActivity, domainCounts, aiOutcomes] = await Promise.all([
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
      // Who wrote the last week's sends — the list's "AI writing" chip. Only AI_WRITTEN and
      // AI_FALLBACK matter there; a TEMPLATE send on a no-provider campaign is the expected case.
      campaignIds.length
        ? prisma.executionLog.groupBy({
            by: ['campaignId', 'aiOutcome'],
            where: {
              campaignId: { in: campaignIds },
              aiOutcome: { in: ['AI_WRITTEN', 'AI_FALLBACK'] },
              createdAt: { gte: weekAgo },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const aiCount = (campaignId: string, outcome: 'AI_WRITTEN' | 'AI_FALLBACK') =>
      aiOutcomes.find((row) => row.campaignId === campaignId && row.aiOutcome === outcome)?._count._all ?? 0;

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
      aiWrittenCount: aiCount(campaign.id, 'AI_WRITTEN'),
      aiFallbackCount: aiCount(campaign.id, 'AI_FALLBACK'),
      _count: undefined,
    }));
  });

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const campaign = await prisma.campaign.findUnique({ where: { id: request.params.id } });
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
    return campaign;
  });

  app.post<{ Body: CreateCampaignBody }>('/', async (request, reply) => {
    const { name, aiPromptTemplate, template, subject, aiProvider, aiMode, aiWritesSubject, unsubscribeUrlTemplate } =
      request.body;
    if (!name?.trim()) return reply.code(422).send({ error: 'name is required' });
    const fieldsError = composeFieldsError(request.body);
    if (fieldsError) return reply.code(422).send({ error: fieldsError });

    let contentQuality: ContentQuality;
    try {
      contentQuality = evaluateContentQuality(template, subject);
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
        subject: subject?.trim() || null,
        aiProvider,
        aiMode,
        aiWritesSubject,
        unsubscribeUrlTemplate,
      },
    });
    return reply.code(201).send({ ...created, contentQuality });
  });

  app.patch<{ Params: { id: string }; Body: UpdateCampaignBody }>(
    '/:id',
    async (request, reply) => {
      const fieldsError = composeFieldsError(request.body);
      if (fieldsError) return reply.code(422).send({ error: fieldsError });
      if (typeof request.body.subject === 'string') {
        request.body.subject = request.body.subject.trim() || null;
      }

      let contentQuality: ContentQuality | undefined;
      if (request.body.template !== undefined || request.body.subject !== undefined) {
        try {
          contentQuality = evaluateContentQuality(request.body.template, request.body.subject);
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

  /** `POST /v1/campaigns/preview` — one email exactly as the send path would write it
   *  (`lib/composeCampaignEmail.ts`), for the dashboard's Preview tab. Takes the draft fields from
   *  the open editor, layered over the saved campaign when `campaignId` is given, so unsaved edits
   *  preview too. Uses one of the campaign's first three leads (`leadIndex`), or a built-in
   *  placeholder lead before any are imported. With a provider this makes one real call on the
   *  customer's own key — the dashboard only calls it on an explicit Preview / Regenerate. Nothing
   *  is stored. */
  app.post<{
    Body: Partial<CreateCampaignBody> & { campaignId?: string; leadIndex?: number };
  }>('/preview', async (request, reply) => {
    const body = request.body ?? {};
    const fieldsError = composeFieldsError(body);
    if (fieldsError) return reply.code(422).send({ error: fieldsError });

    const saved = body.campaignId
      ? await prisma.campaign.findUnique({ where: { id: body.campaignId } })
      : null;
    if (body.campaignId && !saved) return reply.code(404).send({ error: 'Campaign not found' });

    const campaign: ComposeCampaign = {
      template: body.template ?? saved?.template ?? '',
      subject: body.subject !== undefined ? body.subject : (saved?.subject ?? null),
      aiPromptTemplate: body.aiPromptTemplate ?? saved?.aiPromptTemplate ?? '',
      aiProvider: body.aiProvider !== undefined ? (body.aiProvider ?? null) : (saved?.aiProvider ?? null),
      aiMode: body.aiMode ?? saved?.aiMode ?? 'PERSONALIZE',
      aiWritesSubject: body.aiWritesSubject ?? saved?.aiWritesSubject ?? false,
    };
    try {
      evaluateContentQuality(campaign.template, campaign.subject);
    } catch (err) {
      if (err instanceof SpintaxParseError) {
        return reply.code(422).send({ error: `Invalid spintax: ${err.message}` });
      }
      throw err;
    }

    const [leads, mailbox, settings] = await Promise.all([
      saved
        ? prisma.lead.findMany({
            where: { campaignId: saved.id, piiErasedAt: null },
            orderBy: { createdAt: 'asc' },
            take: 3,
            select: { id: true, email: true, firstName: true, lastName: true, company: true, customFields: true },
          })
        : Promise.resolve([]),
      prisma.mailbox.findFirst({
        where: { status: { not: 'PAUSED' } },
        orderBy: { createdAt: 'asc' },
        select: { email: true, senderName: true },
      }),
      prisma.instanceSettings.findUnique({ where: { id: 'default' }, select: { physicalMailingAddress: true } }),
    ]);
    const index = Math.min(Math.max(Math.trunc(Number(body.leadIndex) || 0), 0), Math.max(leads.length - 1, 0));
    const lead = leads[index] ?? SAMPLE_LEAD;
    const senderName = resolveSenderName(mailbox);
    const composed = await composeCampaignEmail({ campaign, lead, senderName });

    // The address + unsubscribe footer `sendMail` adds, so the preview is what the lead receives.
    // When either is missing every send is refused, so the preview says which instead.
    const address = settings?.physicalMailingAddress?.trim() ?? '';
    const unsubscribeTemplate =
      (body.unsubscribeUrlTemplate !== undefined ? body.unsubscribeUrlTemplate : saved?.unsubscribeUrlTemplate)?.trim() ?? '';
    // No link of the campaign's own means the built-in page, signed per lead at send time; the
    // sample lead has no id, so its link is only the right shape.
    const unsubscribeUrl = unsubscribeTemplate
      ? resolveUnsubscribeUrl(unsubscribeTemplate, lead.email)
      : hostedUnsubscribeUrl('id' in lead ? lead.id : 'sample');
    const complianceMissing: Array<'address' | 'unsubscribe'> = [];
    if (!address) complianceMissing.push('address');
    if (!unsubscribeUrl || !/^https?:|^mailto:/i.test(unsubscribeUrl)) complianceMissing.push('unsubscribe');
    const withFooter = (text: string) =>
      complianceMissing.length > 0
        ? text
        : appendCanSpamFooter(text, { physicalMailingAddress: address, unsubscribeUrl }).body;

    return {
      lead: { firstName: lead.firstName, lastName: lead.lastName, company: lead.company, email: lead.email },
      leads: leads.map((row) => ({ firstName: row.firstName, lastName: row.lastName, company: row.company })),
      leadIndex: leads.length ? index : 0,
      sampleLead: leads.length === 0,
      senderName,
      ...composed,
      body: withFooter(composed.body),
      fallback: { ...composed.fallback, body: withFooter(composed.fallback.body) },
      complianceMissing,
    };
  });

  /** `POST /v1/campaigns/field-check` — which `{{fields}}` in the given texts will fill, for the
   *  editor's warning banner. Standard fields always resolve (`senderName` falls back to the
   *  mailbox address); custom fields are checked against the campaign's imported leads, with a
   *  count of leads that have it blank. A token no lead has at all is `unknown` — it would go out
   *  as literal `{{token}}` text in the plain template. */
  app.post<{ Body: { campaignId?: string; texts?: unknown } }>('/field-check', async (request, reply) => {
    const texts = Array.isArray(request.body?.texts)
      ? request.body.texts.filter((text): text is string => typeof text === 'string')
      : [];
    const leads = request.body?.campaignId
      ? await prisma.lead.findMany({
          where: { campaignId: request.body.campaignId, piiErasedAt: null },
          select: { firstName: true, lastName: true, company: true, customFields: true },
          take: 5_000,
        })
      : [];

    const customKeys = new Map<string, string>();
    for (const lead of leads) {
      if (typeof lead.customFields !== 'object' || !lead.customFields) continue;
      for (const key of Object.keys(lead.customFields)) {
        if (!customKeys.has(key.toLowerCase())) customKeys.set(key.toLowerCase(), key);
      }
    }
    const valueOf = (lead: (typeof leads)[number], name: string): unknown => {
      const lower = name.toLowerCase();
      if (lower === 'firstname') return lead.firstName;
      if (lower === 'lastname') return lead.lastName;
      if (lower === 'company') return lead.company;
      const custom = (lead.customFields ?? {}) as Record<string, unknown>;
      const key = Object.keys(custom).find((k) => k.toLowerCase() === lower);
      return key ? custom[key] : undefined;
    };

    const fields = mergeTokens(texts).map((name) => {
      const lower = name.toLowerCase();
      const standard = STANDARD_FIELDS.some((field) => field.toLowerCase() === lower);
      if (!standard && !customKeys.has(lower)) return { name, status: 'unknown' as const, missingCount: leads.length };
      const alwaysSet = lower === 'email' || lower === 'sendername';
      const missingCount = alwaysSet ? 0 : leads.filter((lead) => isBlank(valueOf(lead, name))).length;
      return { name, status: missingCount ? ('partial' as const) : ('ok' as const), missingCount };
    });

    return reply.send({
      leadCount: leads.length,
      available: [...STANDARD_FIELDS, ...[...customKeys.values()].filter((key) => !STANDARD_FIELDS.includes(key))],
      fields,
    });
  });

  /** `GET /v1/campaigns/:id/ai-writing` — who wrote the last `days` (default 7) of this campaign's
   *  sends, why any fell back, and the most recent few. Per the BYOK privacy rule no subject or
   *  body is ever stored, so the recent list is lead + outcome + time only. */
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/:id/ai-writing', async (request, reply) => {
    const campaign = await prisma.campaign.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
    const days = Math.min(Math.max(Number(request.query.days) || 7, 1), 90);
    const where = {
      campaignId: campaign.id,
      aiOutcome: { not: null },
      createdAt: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
    } as const;

    const [byOutcome, byReason, recent] = await Promise.all([
      prisma.executionLog.groupBy({ by: ['aiOutcome'], where, _count: { _all: true } }),
      prisma.executionLog.groupBy({
        by: ['aiFallbackReason'],
        where: { ...where, aiOutcome: 'AI_FALLBACK' },
        _count: { _all: true },
      }),
      prisma.executionLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          aiOutcome: true,
          aiFallbackReason: true,
          createdAt: true,
          lead: { select: { firstName: true, lastName: true, company: true } },
        },
      }),
    ]);
    const count = (outcome: string) => byOutcome.find((row) => row.aiOutcome === outcome)?._count._all ?? 0;

    return {
      days,
      counts: { aiWritten: count('AI_WRITTEN'), template: count('TEMPLATE'), aiFallback: count('AI_FALLBACK') },
      fallbackReasons: byReason
        .map((row) => ({ reason: row.aiFallbackReason ?? 'provider_error', count: row._count._all }))
        .sort((a, b) => b.count - a.count),
      recent: recent.map((row) => ({
        id: row.id,
        aiOutcome: row.aiOutcome,
        aiFallbackReason: row.aiFallbackReason,
        sentAt: row.createdAt,
        lead: row.lead,
      })),
    };
  });

  /** `POST /v1/campaigns/:id/launch` (spec) — the one dedicated "go live" action, distinct from
   *  the generic `PATCH /:id` status setter: refuses to launch a campaign with no unsubscribe
   *  link (the same gate `sendCompliance.ts` enforces per-send, applied here as an up-front check
   *  so a customer finds out at launch time, not on the first failed send) or that's still paused
   *  for a bounce-rate trip that hasn't been resolved. The built-in unsubscribe page counts as a
   *  link, so only an install with no `WARMHAWK_DOMAIN` has to set one on the campaign. */
  app.post<{ Params: { id: string } }>('/:id/launch', async (request, reply) => {
    const campaign = await prisma.campaign.findUnique({ where: { id: request.params.id } });
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
    if (!campaign.unsubscribeUrlTemplate?.trim() && !process.env.WARMHAWK_DOMAIN?.trim()) {
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
