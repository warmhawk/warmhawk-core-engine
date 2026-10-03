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
 *
 * Senders and sequence (10-03-26): a campaign sends first emails only from the mailboxes it ticks
 * (`mailboxIds`, the `CampaignMailbox` rows) and has up to three follow-ups (`steps`). Launch runs
 * the full check in `lib/sendingReadiness.ts` and returns every problem at once; `PATCH` can no
 * longer set `status`, so nothing goes live around that check.
 */
import type { FastifyInstance } from 'fastify';
import { Prisma, prisma, type AiProvider, type CampaignAiMode } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { scoreContent, type SpamScoreResult } from '../lib/spamScore';
import { listSpintaxGroups, SpintaxParseError } from '../lib/spintax';
import {
  composeCampaignEmail,
  resolveSenderName,
  type ComposeCampaign,
  type ComposedEmail,
  type ComposeLead,
} from '../lib/composeCampaignEmail';
import { appendCanSpamFooter, resolveUnsubscribeUrl } from '../lib/sendCompliance';
import { hostedUnsubscribeUrl } from '../lib/unsubscribeToken';
import {
  builtInUnsubscribeAvailable,
  checkCampaignLaunch,
  checkFields,
  domainHasAddress,
  evaluateLaunch,
  readinessInclude,
} from '../lib/sendingReadiness';
import { MAX_FOLLOW_UPS, parseStepsInput, type SequenceStep } from '../lib/sequence';
import { sendMail, MailSendError } from '../lib/mailSender';

interface CreateCampaignBody {
  name: string;
  aiPromptTemplate: string;
  template?: string;
  subject?: string | null;
  aiProvider?: AiProvider;
  aiMode?: CampaignAiMode;
  aiWritesSubject?: boolean;
  unsubscribeUrlTemplate?: string;
  /** Mailboxes to send first emails from. Optional on create — the builder ticks them later. */
  mailboxIds?: string[];
  /** Follow-ups, in order. Each `{ waitDays, body, aiRewrite }`. */
  steps?: unknown;
}

interface UpdateCampaignBody {
  name?: string;
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
  mailboxIds?: string[];
  steps?: unknown;
}

/** The fields `PATCH /:id` writes. Anything else in the body — `status` above all — is refused, so
 *  a campaign only goes live through `POST /:id/launch` and its checks. */
const PATCHABLE_FIELDS = [
  'name',
  'template',
  'subject',
  'aiPromptTemplate',
  'aiProvider',
  'aiMode',
  'aiWritesSubject',
  'unsubscribeUrlTemplate',
  'bounceRateThreshold',
  'pausedForBounceRate',
] as const;
const AI_PROVIDERS: AiProvider[] = ['GEMINI', 'CLAUDE'];

interface ContentQuality {
  spamScore: SpamScoreResult;
  spintaxGroupCount: number;
}

/** Throws on unbalanced spintax (surfaced by the route as a 422); returns the computed
 *  content-quality metadata otherwise. The subject is scored with the body — spam filters read
 *  both — and its spintax is validated the same way. */
function evaluateContentQuality(
  template: string | undefined | null,
  subject?: string | null,
): ContentQuality {
  const content = template ?? '';
  const spintaxGroupCount = content ? listSpintaxGroups(content).length : 0;
  if (subject) listSpintaxGroups(subject);
  return {
    spamScore: scoreContent(subject ? `${subject}\n${content}` : content),
    spintaxGroupCount,
  };
}

const AI_MODES: CampaignAiMode[] = ['PERSONALIZE', 'PROMPT'];
const SAMPLE_LEAD = {
  email: 'dana@acme.example',
  firstName: 'Dana',
  lastName: 'Reyes',
  company: 'Acme Logistics',
  customFields: { title: 'Head of Operations', city: 'Denver' },
};

/** The new compose fields share one check between create and update; `null` is a valid subject
 *  (clears it back to the first-line rule). Returns an error message, or null when valid. */
function composeFieldsError(body: {
  subject?: unknown;
  aiMode?: unknown;
  aiWritesSubject?: unknown;
}): string | null {
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

interface PreviewBody extends Partial<Omit<CreateCampaignBody, 'steps'>> {
  campaignId?: string;
  leadIndex?: number;
  /** 0 (default) = the first email; 1..3 = that follow-up. */
  step?: number;
  /** Draft follow-ups from the editor, used instead of the saved ones. */
  steps?: unknown;
}

type PreviewResult =
  | { error: string; code: number }
  | (ComposedEmail & {
      lead: Pick<ComposeLead, 'firstName' | 'lastName' | 'company' | 'email'>;
      leads: Array<Pick<ComposeLead, 'firstName' | 'lastName' | 'company'>>;
      leadIndex: number;
      sampleLead: boolean;
      senderName: string | null;
      step: number;
      sender: { email: string; senderName: string | null; domainName: string } | null;
      complianceMissing: Array<'sender' | 'address' | 'unsubscribe'>;
      /** Internal — the mailbox a test send goes from. Not returned by `/preview`. */
      mailbox: { id: string; email: string } | null;
    });

/** One email exactly as a lead gets it — the right sender, that sender's domain address in the
 *  footer, and, for a follow-up, the "Re:" subject and backup text. Shared by `/preview` and
 *  `/:id/test-send`. */
async function buildPreview(body: PreviewBody): Promise<PreviewResult> {
  const fieldsError = composeFieldsError(body);
  if (fieldsError) return { error: fieldsError, code: 422 };

  const saved = body.campaignId
    ? await prisma.campaign.findUnique({
        where: { id: body.campaignId },
        include: readinessInclude,
      })
    : null;
  if (body.campaignId && !saved) return { error: 'Campaign not found', code: 404 };

  const campaign: ComposeCampaign = {
    template: body.template ?? saved?.template ?? '',
    subject: body.subject !== undefined ? body.subject : (saved?.subject ?? null),
    aiPromptTemplate: body.aiPromptTemplate ?? saved?.aiPromptTemplate ?? '',
    aiProvider:
      body.aiProvider !== undefined ? (body.aiProvider ?? null) : (saved?.aiProvider ?? null),
    aiMode: body.aiMode ?? saved?.aiMode ?? 'PERSONALIZE',
    aiWritesSubject: body.aiWritesSubject ?? saved?.aiWritesSubject ?? false,
  };
  try {
    evaluateContentQuality(campaign.template, campaign.subject);
  } catch (err) {
    if (err instanceof SpintaxParseError)
      return { error: `Invalid spintax: ${err.message}`, code: 422 };
    throw err;
  }

  let steps: SequenceStep[] = saved?.steps ?? [];
  if (body.steps !== undefined) {
    const parsed = parseStepsInput(body.steps);
    if (!parsed.ok) return { error: parsed.error, code: 422 };
    steps = parsed.steps;
  }
  const step = Math.trunc(Number(body.step) || 0);
  const followUp = step > 0 ? steps.find((s) => s.position === step) : undefined;
  if (step > 0 && !followUp) return { error: `There is no follow-up ${step}`, code: 422 };

  // The sender: the first ticked mailbox that isn't paused (the draft's ticks win over the saved).
  let senderIds = saved?.mailboxes.map((link) => link.mailboxId) ?? [];
  if (body.mailboxIds !== undefined) {
    if (!Array.isArray(body.mailboxIds))
      return { error: 'mailboxIds must be a list of mailbox ids', code: 422 };
    senderIds = body.mailboxIds.filter((id): id is string => typeof id === 'string');
  }
  const candidates = senderIds.length
    ? await prisma.mailbox.findMany({
        where: { id: { in: senderIds } },
        select: {
          id: true,
          email: true,
          status: true,
          senderName: true,
          domain: { select: { domainName: true, mailingAddress: true } },
        },
      })
    : [];
  const ordered = senderIds
    .map((id) => candidates.find((m) => m.id === id))
    .filter((m): m is (typeof candidates)[number] => Boolean(m));
  const mailbox = ordered.find((m) => m.status !== 'PAUSED') ?? ordered[0] ?? null;

  const leads = saved
    ? await prisma.lead.findMany({
        where: { campaignId: saved.id, piiErasedAt: null },
        orderBy: { createdAt: 'asc' },
        take: 3,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          company: true,
          customFields: true,
        },
      })
    : [];
  const index = Math.min(
    Math.max(Math.trunc(Number(body.leadIndex) || 0), 0),
    Math.max(leads.length - 1, 0),
  );
  const lead = leads[index] ?? SAMPLE_LEAD;
  const senderName = resolveSenderName(mailbox);

  let composed: ComposedEmail;
  if (followUp) {
    // The thread subject is the first email's — rendered without AI, so a preview never pays for
    // a model call it throws away.
    const first = await composeCampaignEmail({
      campaign: { ...campaign, aiProvider: null },
      lead,
      senderName,
    });
    composed = await composeCampaignEmail({
      campaign,
      lead,
      senderName,
      followUp: {
        position: followUp.position,
        body: followUp.body,
        aiRewrite: followUp.aiRewrite,
        threadSubject: first.subject,
      },
    });
  } else {
    composed = await composeCampaignEmail({ campaign, lead, senderName });
  }

  // The address + unsubscribe footer `sendMail` adds, so the preview is what the lead receives.
  // When either is missing every send is refused, so the preview says which instead.
  const address = mailbox?.domain.mailingAddress?.trim() ?? '';
  const unsubscribeTemplate =
    (body.unsubscribeUrlTemplate !== undefined
      ? body.unsubscribeUrlTemplate
      : saved?.unsubscribeUrlTemplate
    )?.trim() ?? '';
  // No link of the campaign's own means the built-in page, signed per lead at send time; the
  // sample lead has no id, so its link is only the right shape.
  const unsubscribeUrl = unsubscribeTemplate
    ? resolveUnsubscribeUrl(unsubscribeTemplate, lead.email)
    : hostedUnsubscribeUrl('id' in lead ? lead.id : 'sample');
  const complianceMissing: Array<'sender' | 'address' | 'unsubscribe'> = [];
  if (!mailbox) complianceMissing.push('sender');
  else if (!address) complianceMissing.push('address');
  if (!unsubscribeUrl || !/^https?:|^mailto:/i.test(unsubscribeUrl))
    complianceMissing.push('unsubscribe');
  const withFooter = (text: string) =>
    complianceMissing.length > 0
      ? text
      : appendCanSpamFooter(text, { physicalMailingAddress: address, unsubscribeUrl }).body;

  return {
    lead: {
      firstName: lead.firstName,
      lastName: lead.lastName,
      company: lead.company,
      email: lead.email,
    },
    leads: leads.map((row) => ({
      firstName: row.firstName,
      lastName: row.lastName,
      company: row.company,
    })),
    leadIndex: leads.length ? index : 0,
    sampleLead: leads.length === 0,
    senderName,
    step: followUp ? step : 0,
    sender: mailbox
      ? {
          email: mailbox.email,
          senderName: mailbox.senderName,
          domainName: mailbox.domain.domainName,
        }
      : null,
    ...composed,
    body: withFooter(composed.body),
    fallback: { ...composed.fallback, body: withFooter(composed.fallback.body) },
    complianceMissing,
    mailbox: mailbox ? { id: mailbox.id, email: mailbox.email } : null,
  };
}

/** Validates `mailboxIds` and that every id is a real mailbox. Returns the de-duplicated list, or
 *  an error message. */
async function parseMailboxIds(
  input: unknown,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  if (!Array.isArray(input) || input.some((id) => typeof id !== 'string')) {
    return { ok: false, error: 'mailboxIds must be a list of mailbox ids' };
  }
  const ids = [...new Set(input as string[])];
  if (ids.length > 500) return { ok: false, error: 'Too many mailboxes' };
  const found = await prisma.mailbox.count({ where: { id: { in: ids } } });
  if (found !== ids.length) return { ok: false, error: 'One or more mailboxes no longer exist' };
  return { ok: true, ids };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A lead contacted longer ago than this doesn't get a follow-up added after the fact — a "Re:"
 *  to an email from months back reads as spam. */
const RESCHEDULE_LOOKBACK_DAYS = 30;

/** Replaces a campaign's senders and/or follow-ups, then re-times every waiting lead's next
 *  follow-up against the new steps (counted from the email it last got). A lead whose queued
 *  follow-up is already on its way keeps it. */
async function writeSendersAndSteps(
  campaignId: string,
  mailboxIds: string[] | undefined,
  steps: SequenceStep[] | undefined,
): Promise<void> {
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  if (mailboxIds) {
    writes.push(
      prisma.campaignMailbox.deleteMany({
        where: { campaignId, mailboxId: { notIn: mailboxIds } },
      }),
      prisma.campaignMailbox.createMany({
        data: mailboxIds.map((mailboxId) => ({ campaignId, mailboxId })),
        skipDuplicates: true,
      }),
    );
  }
  if (steps) {
    writes.push(
      prisma.campaignStep.deleteMany({ where: { campaignId } }),
      prisma.campaignStep.createMany({ data: steps.map((step) => ({ ...step, campaignId })) }),
    );
    const since = new Date(Date.now() - RESCHEDULE_LOOKBACK_DAYS * DAY_MS);
    for (let sent = 1; sent <= MAX_FOLLOW_UPS + 1; sent += 1) {
      const next = steps.find((step) => step.position === sent);
      writes.push(
        prisma.$executeRaw`
          UPDATE "leads"
          SET "nextStepAt" = CASE WHEN ${next ? next.waitDays : null}::int IS NULL THEN NULL
                                  ELSE "lastStepAt" + make_interval(days => ${next ? next.waitDays : 0}::int) END
          WHERE "campaignId" = ${campaignId}
            AND "stepsSent" = ${sent}
            AND "status" IN ('CONTACTED', 'OPENED')
            AND "queuedJobId" IS NULL
            AND "lastStepAt" IS NOT NULL
            AND ("nextStepAt" IS NOT NULL OR "lastStepAt" >= ${since})`,
      );
    }
  }
  if (writes.length) await prisma.$transaction(writes);
}

/** The campaign with its senders and follow-ups, as the dashboard reads it. */
async function loadCampaignDetail(id: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: readinessInclude });
  if (!campaign) return null;
  const { mailboxes, ...rest } = campaign;
  return {
    ...rest,
    mailboxIds: mailboxes.map((link) => link.mailboxId),
    steps: campaign.steps.map(({ position, waitDays, body, aiRewrite }) => ({
      position,
      waitDays,
      body,
      aiRewrite,
    })),
  };
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
        ...readinessInclude,
      },
    });

    const campaignIds = campaigns.map((c) => c.id);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [
      sentCounts,
      lastActivity,
      domainCounts,
      aiOutcomes,
      leadStatuses,
      followUpsDue,
      sentToday,
    ] = await Promise.all([
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
      // The card's progress bar and bounce figure.
      campaignIds.length
        ? prisma.lead.groupBy({
            by: ['campaignId', 'status'],
            where: { campaignId: { in: campaignIds } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      campaignIds.length
        ? prisma.lead.groupBy({
            by: ['campaignId'],
            where: {
              campaignId: { in: campaignIds },
              nextStepAt: { not: null },
              status: { in: ['CONTACTED', 'OPENED'] },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      campaignIds.length
        ? prisma.executionLog.groupBy({
            by: ['campaignId'],
            where: {
              campaignId: { in: campaignIds },
              status: 'SENT',
              createdAt: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const statusCount = (campaignId: string, status: string) =>
      leadStatuses.find((row) => row.campaignId === campaignId && row.status === status)?._count
        ._all ?? 0;
    const builtInUnsubscribe = builtInUnsubscribeAvailable();
    const aiCount = (campaignId: string, outcome: 'AI_WRITTEN' | 'AI_FALLBACK') =>
      aiOutcomes.find((row) => row.campaignId === campaignId && row.aiOutcome === outcome)?._count
        ._all ?? 0;

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

    return campaigns.map(({ mailboxes: links, ...campaign }) => {
      const mailboxes = links.map((link) => link.mailbox);
      const launch = evaluateLaunch({ ...campaign, mailboxes }, { builtInUnsubscribe });
      return {
        ...campaign,
        steps: campaign.steps.map(({ position, waitDays, body, aiRewrite }) => ({
          position,
          waitDays,
          body,
          aiRewrite,
        })),
        mailboxIds: mailboxes.map((m) => m.id),
        // "Sends from" chips: each ticked mailbox and whether it can send right now.
        senders: mailboxes.map((m) => ({
          id: m.id,
          email: m.email,
          status: m.status,
          domainName: m.domain.domainName,
          domainHasAddress: domainHasAddress(m.domain),
        })),
        launch: { canLaunch: launch.canLaunch, problems: launch.problems },
        progress: {
          untouched: statusCount(campaign.id, 'UNTOUCHED') + statusCount(campaign.id, 'QUEUED'),
          contacted: statusCount(campaign.id, 'CONTACTED') + statusCount(campaign.id, 'OPENED'),
          replied: statusCount(campaign.id, 'REPLIED'),
          bounced: statusCount(campaign.id, 'BOUNCED'),
          stopped: statusCount(campaign.id, 'SUPPRESSED') + statusCount(campaign.id, 'FAILED'),
          followUpsDue:
            followUpsDue.find((row) => row.campaignId === campaign.id)?._count._all ?? 0,
          sentToday: sentToday.find((row) => row.campaignId === campaign.id)?._count._all ?? 0,
        },
        leadsCount: campaign._count.leads,
        repliesCount: campaign._count.replies,
        sentCount: sentByCampaign.get(campaign.id) ?? 0,
        domainsCount: domainsByCampaign.get(campaign.id)?.size ?? 0,
        lastActivityAt: lastActivityByCampaign.get(campaign.id) ?? null,
        aiWrittenCount: aiCount(campaign.id, 'AI_WRITTEN'),
        aiFallbackCount: aiCount(campaign.id, 'AI_FALLBACK'),
        _count: undefined,
      };
    });
  });

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const campaign = await loadCampaignDetail(request.params.id);
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
    return campaign;
  });

  /** `GET /v1/campaigns/:id/launch-check` — the launch check without launching, for the builder's
   *  Launch step and the import dialog's "left to do" card. */
  app.get<{ Params: { id: string } }>('/:id/launch-check', async (request, reply) => {
    const check = await checkCampaignLaunch(request.params.id);
    if (!check) return reply.code(404).send({ error: 'Campaign not found' });
    return check;
  });

  app.post<{ Body: CreateCampaignBody }>('/', async (request, reply) => {
    const {
      name,
      aiPromptTemplate,
      template,
      subject,
      aiProvider,
      aiMode,
      aiWritesSubject,
      unsubscribeUrlTemplate,
    } = request.body;
    if (!name?.trim()) return reply.code(422).send({ error: 'name is required' });
    const fieldsError = composeFieldsError(request.body);
    if (fieldsError) return reply.code(422).send({ error: fieldsError });
    if (aiProvider != null && !AI_PROVIDERS.includes(aiProvider)) {
      return reply.code(422).send({ error: 'aiProvider must be GEMINI or CLAUDE' });
    }
    const senders =
      request.body.mailboxIds !== undefined ? await parseMailboxIds(request.body.mailboxIds) : null;
    if (senders && !senders.ok) return reply.code(422).send({ error: senders.error });
    const steps = request.body.steps !== undefined ? parseStepsInput(request.body.steps) : null;
    if (steps && !steps.ok) return reply.code(422).send({ error: steps.error });

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
    await writeSendersAndSteps(
      created.id,
      senders?.ok ? senders.ids : undefined,
      steps?.ok ? steps.steps : undefined,
    );
    return reply.code(201).send({ ...(await loadCampaignDetail(created.id)), contentQuality });
  });

  app.patch<{ Params: { id: string }; Body: UpdateCampaignBody }>(
    '/:id',
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      if ('status' in body) {
        return reply.code(422).send({
          error: 'status cannot be set here — use POST /v1/campaigns/:id/launch or /pause',
        });
      }
      const unknown = Object.keys(body).filter(
        (key) =>
          !(PATCHABLE_FIELDS as readonly string[]).includes(key) &&
          key !== 'mailboxIds' &&
          key !== 'steps',
      );
      if (unknown.length)
        return reply.code(422).send({ error: `Unknown field: ${unknown.join(', ')}` });
      const fieldsError = composeFieldsError(request.body);
      if (fieldsError) return reply.code(422).send({ error: fieldsError });
      if (request.body.aiProvider != null && !AI_PROVIDERS.includes(request.body.aiProvider)) {
        return reply.code(422).send({ error: 'aiProvider must be GEMINI or CLAUDE' });
      }
      if (typeof request.body.subject === 'string') {
        request.body.subject = request.body.subject.trim() || null;
      }
      const senders =
        request.body.mailboxIds !== undefined
          ? await parseMailboxIds(request.body.mailboxIds)
          : null;
      if (senders && !senders.ok) return reply.code(422).send({ error: senders.error });
      const steps = request.body.steps !== undefined ? parseStepsInput(request.body.steps) : null;
      if (steps && !steps.ok) return reply.code(422).send({ error: steps.error });

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

      const data = Object.fromEntries(
        PATCHABLE_FIELDS.filter((key) => request.body[key] !== undefined).map((key) => [
          key,
          request.body[key],
        ]),
      );
      const updated = await prisma.campaign
        .update({ where: { id: request.params.id }, data })
        .catch(() => null);
      if (!updated) return reply.code(404).send({ error: 'Campaign not found' });
      await writeSendersAndSteps(
        updated.id,
        senders?.ok ? senders.ids : undefined,
        steps?.ok ? steps.steps : undefined,
      );
      const detail = await loadCampaignDetail(updated.id);
      return contentQuality ? { ...detail, contentQuality } : detail;
    },
  );

  /** `POST /v1/campaigns/preview` — one email exactly as the send path would write it
   *  (`lib/composeCampaignEmail.ts`), for the dashboard's Preview tab. Takes the draft fields from
   *  the open editor, layered over the saved campaign when `campaignId` is given, so unsaved edits
   *  preview too. Uses one of the campaign's first three leads (`leadIndex`), or a built-in
   *  placeholder lead before any are imported. With a provider this makes one real call on the
   *  customer's own key — the dashboard only calls it on an explicit Preview / Regenerate. Nothing
   *  is stored. */
  app.post<{ Body: PreviewBody }>('/preview', async (request, reply) => {
    const built = await buildPreview(request.body ?? {});
    if ('error' in built) return reply.code(built.code).send({ error: built.error });
    const { mailbox: _mailbox, ...preview } = built;
    return preview;
  });

  /** `POST /v1/campaigns/:id/test-send` — "Send me a test": one email (or follow-up `step`) as
   *  lead `leadIndex` would get it, footer included, from the campaign's first ticked mailbox, to
   *  `to` (the dashboard passes the signed-in user's address). It isn't a campaign send — no lead
   *  row changes, nothing is logged against the campaign — and the subject says "[Test]". */
  app.post<{ Params: { id: string }; Body: { to?: string; step?: number; leadIndex?: number } }>(
    '/:id/test-send',
    async (request, reply) => {
      const to = typeof request.body?.to === 'string' ? request.body.to.trim() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))
        return reply.code(422).send({ error: 'A valid "to" address is required' });
      const built = await buildPreview({
        campaignId: request.params.id,
        step: request.body?.step,
        leadIndex: request.body?.leadIndex,
      });
      if ('error' in built) return reply.code(built.code).send({ error: built.error });
      if (!built.mailbox)
        return reply.code(422).send({ error: 'Pick a mailbox to send from first' });
      if (built.complianceMissing.length > 0) {
        return reply.code(422).send({
          error: built.complianceMissing.includes('address')
            ? `${built.sender?.domainName ?? 'The sending domain'} has no mailing address — add it on the Domains page`
            : 'This campaign has no working unsubscribe link',
          complianceMissing: built.complianceMissing,
        });
      }
      try {
        const sent = await sendMail({
          mailboxId: built.mailbox.id,
          to,
          subject: `[Test] ${built.subject}`,
          body: built.body,
        });
        return { status: 'sent', to, from: built.mailbox.email, messageId: sent.messageId };
      } catch (err) {
        if (err instanceof MailSendError) return reply.code(502).send({ error: err.message });
        throw err;
      }
    },
  );

  /** `POST /v1/campaigns/field-check` — which `{{fields}}` in the given texts will fill, for the
   *  editor's warning banner. Standard fields always resolve (`senderName` falls back to the
   *  mailbox address); custom fields are checked against the campaign's imported leads, with a
   *  count of leads that have it blank. A token no lead has at all is `unknown` — it would go out
   *  as literal `{{token}}` text in the plain template. */
  app.post<{ Body: { campaignId?: string; texts?: unknown } }>(
    '/field-check',
    async (request, reply) => {
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
      return reply.send({ leadCount: leads.length, ...checkFields(texts, leads) });
    },
  );

  /** `GET /v1/campaigns/:id/ai-writing` — who wrote the last `days` (default 7) of this campaign's
   *  sends, why any fell back, and the most recent few. Per the BYOK privacy rule no subject or
   *  body is ever stored, so the recent list is lead + outcome + time only. */
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/:id/ai-writing',
    async (request, reply) => {
      const campaign = await prisma.campaign.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
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
      const count = (outcome: string) =>
        byOutcome.find((row) => row.aiOutcome === outcome)?._count._all ?? 0;

      return {
        days,
        counts: {
          aiWritten: count('AI_WRITTEN'),
          template: count('TEMPLATE'),
          aiFallback: count('AI_FALLBACK'),
        },
        fallbackReasons: byReason
          .map((row) => ({
            reason: row.aiFallbackReason ?? 'provider_error',
            count: row._count._all,
          }))
          .sort((a, b) => b.count - a.count),
        recent: recent.map((row) => ({
          id: row.id,
          aiOutcome: row.aiOutcome,
          aiFallbackReason: row.aiFallbackReason,
          sentAt: row.createdAt,
          lead: row.lead,
        })),
      };
    },
  );

  /** `POST /v1/campaigns/:id/launch` (spec) — the one way a campaign goes live. Runs the full
   *  launch check (`lib/sendingReadiness.ts`): senders picked, every sending domain has a mailing
   *  address, an unsubscribe link (the built-in page counts when `WARMHAWK_DOMAIN` is set), not
   *  bounce-paused, and no empty email or follow-up. Every problem comes back at once in a 422
   *  `{ error, problems, warnings }`; warnings never block. */
  app.post<{ Params: { id: string } }>('/:id/launch', async (request, reply) => {
    const check = await checkCampaignLaunch(request.params.id);
    if (!check) return reply.code(404).send({ error: 'Campaign not found' });
    if (!check.canLaunch) {
      return reply.code(422).send({
        error: check.problems.map((problem) => problem.message).join('; '),
        problems: check.problems,
        warnings: check.warnings,
      });
    }
    await prisma.campaign.update({ where: { id: request.params.id }, data: { status: 'ACTIVE' } });
    return { ...(await loadCampaignDetail(request.params.id)), warnings: check.warnings };
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
