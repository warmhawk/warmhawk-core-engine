/**
 * Leads management — new, Phase 2: `POST /leads/import` (CSV upload) and the Guardrails-required
 * `DELETE /leads/:id` (GDPR right-to-erasure, HARD delete, not a status flag — "WarmHawk
 * customers are themselves data controllers for their leads under GDPR and need to be able to
 * honor erasure requests").
 *
 * `POST /leads/import` shares the exact same row-validation function (`validateLeadFields`) as
 * the webhook ingest route (`webhookLeads.ts`) — CSV injection defense, email format, blocked
 * domains, suppression/duplicate skip-not-error semantics are identical across both entry
 * points, per the V12 spec's explicit factoring requirement.
 *
 * `POST /leads/import-rows` (10-03-26) is the dashboard's 4-step import: the browser parses the
 * CSV and maps its columns, then sends the rows as JSON — first with `dryRun: true` for the Check
 * step's counts, then for real. Same validation as the CSV route, plus two optional rules: skip
 * people already in another campaign, and skip role addresses (info@, sales@ …).
 */
import type { FastifyInstance } from 'fastify';
import { parse } from 'csv-parse/sync';
import { prisma, Prisma, type LeadStatus } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { parseChoice, parsePage, wantsPage, type PageQuery } from '../lib/pagination';
import {
  validateLeadFields,
  isEmailSuppressed,
  isDuplicateLead,
  type RawLeadInput,
} from '../lib/leadIngest';
import { suppressEmail } from '../lib/suppression';
import { MAX_CSV_ROWS, MAX_CSV_FILE_BYTES, RATE_LIMIT_CSV_IMPORT } from '../../../../constants';

interface ImportRejection {
  row: number;
  reason: string;
}

interface ImportResponse {
  imported: number;
  skippedDuplicate: number;
  skippedSuppressed: number;
  rejected: ImportRejection[];
}

const KNOWN_COLUMNS = new Set(['email', 'firstname', 'lastname', 'company']);

/** Shared inboxes rather than a person — the import's "Skip role addresses" rule. */
const ROLE_LOCAL_PARTS = new Set([
  'admin',
  'billing',
  'contact',
  'enquiries',
  'help',
  'hello',
  'hi',
  'info',
  'inquiries',
  'jobs',
  'marketing',
  'media',
  'news',
  'noreply',
  'no-reply',
  'office',
  'press',
  'sales',
  'support',
  'team',
]);

export function isRoleAddress(email: string): boolean {
  return ROLE_LOCAL_PARTS.has(email.split('@')[0]?.toLowerCase() ?? '');
}

interface ImportRowsBody {
  campaignId?: unknown;
  rows?: unknown;
  dryRun?: unknown;
  rules?: { skipInOtherCampaigns?: unknown; skipRoleAddresses?: unknown };
}

interface ImportRowsResult {
  dryRun: boolean;
  total: number;
  /** Rows that will be (dry run) or were imported. */
  imported: number;
  skippedDuplicate: number;
  skippedSuppressed: number;
  skippedOtherCampaign: number;
  skippedRole: number;
  rejected: Array<{ row: number; email: string; reason: string }>;
}

const REJECTION_TEXT: Record<string, string> = {
  invalid_email: 'Not a valid email address',
  blocked_domain: 'Disposable or test domain',
  csv_injection_risk: 'A cell starts like a spreadsheet formula',
  missing_campaign_id: 'No campaign',
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

/** Parses a raw CSV buffer into an array of RawLeadInput-shaped records, folding any
 *  unrecognized column into `customFields` (case-insensitive `email`/`firstName`/`lastName`/
 *  `company` are the only recognized top-level columns, per Phase 2). */
export function parseLeadsCsv(csvBuffer: Buffer, campaignId: string): RawLeadInput[] {
  const records: Record<string, string>[] = parse(csvBuffer, {
    columns: (header: string[]) => header.map(normalizeHeader),
    skip_empty_lines: true,
    trim: true,
  });

  return records.map((record) => {
    const customFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!KNOWN_COLUMNS.has(key)) {
        customFields[key] = value;
      }
    }
    return {
      campaignId,
      email: record.email ?? '',
      firstName: record.firstname ?? null,
      lastName: record.lastname ?? null,
      company: record.company ?? null,
      customFields,
    };
  });
}

interface ListLeadsQuery extends PageQuery {
  campaignId?: string;
  status?: string;
  q?: string;
  sort?: string;
  dir?: string;
}

const LEAD_STATUSES = [
  'UNTOUCHED',
  'QUEUED',
  'CONTACTED',
  'OPENED',
  'REPLIED',
  'BOUNCED',
  'FAILED',
  'SUPPRESSED',
] as const satisfies readonly LeadStatus[];

const LEAD_SORTS = ['name', 'email', 'company', 'campaign', 'status', 'added'] as const;
type LeadSort = (typeof LEAD_SORTS)[number];

/** `status` sorts in pipeline order because the Postgres enum is declared in that order. The
 *  trailing `id` keeps page boundaries stable when many rows share a value. */
function leadOrderBy(sort: LeadSort, dir: Prisma.SortOrder): Prisma.LeadOrderByWithRelationInput[] {
  const nulls = { sort: dir, nulls: 'last' as const };
  const primary: Prisma.LeadOrderByWithRelationInput[] = {
    name: [{ firstName: nulls }, { lastName: nulls }],
    email: [{ email: dir }],
    company: [{ company: nulls }],
    campaign: [{ campaign: { name: dir } }],
    status: [{ status: dir }],
    added: [{ createdAt: dir }],
  }[sort];
  return [...primary, { id: dir }];
}

interface CreateLeadBody {
  campaignId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  customFields?: Record<string, unknown>;
}

interface EraseLeadsBody {
  email: string;
}

/** GDPR-erasure placeholder — deterministic per-lead so `@@unique([campaignId, email])` can never
 *  collide across two different leads erased in the same campaign. Never reversible, never a real
 *  mailbox. */
function anonymizedEmail(leadId: string): string {
  return `erased-${leadId}@erased.invalid`;
}

export async function leadsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** The dashboard's Leads page. With `?page`/`?pageSize` it returns one page, filtered and
   *  sorted in the database (`status`, `campaignId`, `q` over email/name/company, `sort`+`dir`),
   *  plus `statusCounts` across every lead for the status chips. Without them it returns every
   *  lead, as it did before paging, for dashboards that predate it. */
  app.get<{ Querystring: ListLeadsQuery }>('/', async (request, reply) => {
    const { campaignId } = request.query;
    if (!wantsPage(request.query)) {
      const where = campaignId ? { campaignId } : {};
      const [leads, total] = await Promise.all([
        prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' } }),
        prisma.lead.count({ where }),
      ]);
      return { leads, total };
    }

    const page = parsePage(request.query);
    if (!page.ok) return reply.code(400).send({ error: page.error });
    const status = parseChoice(request.query.status, LEAD_STATUSES, 'status');
    if (!status.ok) return reply.code(400).send({ error: status.error });
    const sort = parseChoice(request.query.sort, LEAD_SORTS, 'sort');
    if (!sort.ok) return reply.code(400).send({ error: sort.error });
    const dir = parseChoice(request.query.dir, ['asc', 'desc'] as const, 'dir');
    if (!dir.ok) return reply.code(400).send({ error: dir.error });

    const q = request.query.q?.trim();
    const where: Prisma.LeadWhereInput = {
      ...(campaignId ? { campaignId } : {}),
      ...(status.value ? { status: status.value } : {}),
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { company: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [leads, total, byStatus] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: leadOrderBy(sort.value ?? 'added', dir.value ?? (sort.value ? 'asc' : 'desc')),
        skip: page.value.skip,
        take: page.value.take,
      }),
      prisma.lead.count({ where }),
      prisma.lead.groupBy({
        by: ['status'],
        where: campaignId ? { campaignId } : {},
        _count: { _all: true },
      }),
    ]);

    const statusCounts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<
      LeadStatus,
      number
    >;
    for (const row of byStatus) statusCounts[row.status] = row._count._all;

    return { leads, total, page: page.value.page, pageSize: page.value.pageSize, statusCounts };
  });

  /** `POST /v1/leads` (spec) — single-lead create, the one authenticated-dashboard entry point
   *  that was missing entirely (bulk CSV import and the unauthenticated webhook both existed, a
   *  direct single-record create didn't). Shares the exact same validation/suppression/duplicate
   *  checks as both of those via `leadIngest.ts` — same guardrail enforcement, just a single row.
   *  Unlike the webhook route's skip-not-error semantics (built for high-volume automated
   *  ingestion where a caller can't act on a 409), this is a direct human/API-key-driven create,
   *  so suppression/duplication are reported as real errors the caller can see and act on. */
  app.post<{ Body: CreateLeadBody }>('/', async (request, reply) => {
    const validation = validateLeadFields(request.body as RawLeadInput);
    if (!validation.valid) {
      return reply.code(422).send({ error: validation.reason });
    }
    const { lead } = validation;

    if (await isEmailSuppressed(lead.email)) {
      return reply.code(409).send({ error: 'This email address is on the suppression list' });
    }
    if (await isDuplicateLead(lead.campaignId, lead.email)) {
      return reply.code(409).send({ error: 'This email is already a lead on this campaign' });
    }

    const created = await prisma.lead.create({
      data: {
        campaignId: lead.campaignId,
        email: lead.email,
        firstName: lead.firstName,
        lastName: lead.lastName,
        company: lead.company,
        customFields: lead.customFields as Prisma.InputJsonValue,
        status: 'UNTOUCHED',
      },
    });
    return reply.code(201).send(created);
  });

  /** NEW, additive — manual suppression, dashboard-triggered (e.g. the Replies page's "Suppress
   *  lead" action), distinct from the automatic OPT_OUT-classification suppression already built
   *  in internalAi.ts's classify-reply. Same SuppressionEntry upsert + Lead.status flip, just
   *  triggered by a human instead of AI classification. */
  app.post<{ Params: { id: string } }>('/:id/suppress', async (request, reply) => {
    const lead = await prisma.lead.findUnique({ where: { id: request.params.id } });
    if (!lead) return reply.code(404).send({ error: 'Lead not found' });

    await suppressEmail(lead.email, {
      source: 'manual',
      reason: 'Manually suppressed from dashboard',
    });
    const updated = await prisma.lead.findUnique({ where: { id: lead.id } });
    return updated;
  });

  app.post(
    '/import',
    {
      config: {
        rateLimit: {
          max: RATE_LIMIT_CSV_IMPORT.max,
          timeWindow: RATE_LIMIT_CSV_IMPORT.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      // Bug fix (live-stack verification, 2026-09-04): this used to be `const file =
      // await request.file(...)` followed by reading `file.fields.campaignId`. But
      // `request.file()` resolves as soon as busboy emits its very first *file* part-event —
      // it does not wait for the rest of the multipart stream to be parsed. The `.fields`
      // object it hands back is the SAME object busboy keeps mutating as later parts arrive, so
      // any field appearing AFTER the file part in the raw multipart body simply isn't there yet
      // at the moment this code used to read it. The dashboard's import dialog builds its
      // FormData as `formData.append("file", file); formData.append("campaignId", campaignId)`
      // (see warmhawk-enterprise-operator's import-leads-dialog.tsx), which serializes the file
      // part first — so every real browser-originated import hit this and got a false
      // "campaignId field is required" 422, while an otherwise-identical curl request with
      // `-F campaignId=... -F file=@...` (campaignId first) worked fine. Multipart part order
      // isn't something a caller should have to get right, so this now drains the FULL stream via
      // `request.parts()` — collecting the file and every field regardless of the order they
      // arrived in — before deciding anything is missing.
      let buffer: Buffer | undefined;
      let campaignId: string | undefined;

      for await (const part of request.parts({ limits: { fileSize: MAX_CSV_FILE_BYTES } })) {
        if (part.type === 'file') {
          if (buffer === undefined) {
            buffer = await part.toBuffer();
          }
        } else if (part.fieldname === 'campaignId') {
          campaignId = String(part.value);
        }
      }

      if (buffer === undefined) {
        return reply.code(422).send({ error: 'A CSV file field is required' });
      }
      if (!campaignId) {
        return reply.code(422).send({ error: 'campaignId field is required' });
      }

      if (buffer.byteLength > MAX_CSV_FILE_BYTES) {
        return reply.code(413).send({
          error: `That file is too large. The limit is ${MAX_CSV_FILE_BYTES / (1024 * 1024)} MB.`,
        });
      }

      let rawLeads: RawLeadInput[];
      try {
        rawLeads = parseLeadsCsv(buffer, campaignId);
      } catch (err) {
        const line = (err as { lines?: number }).lines;
        return reply.code(422).send({
          error: `This file couldn't be read as a CSV${line ? ` (the problem is near line ${line})` : ''}. Save it as CSV with a header row, and make sure every row has the same number of columns.`,
        });
      }

      if (rawLeads.length > MAX_CSV_ROWS) {
        return reply.code(413).send({ error: `CSV exceeds the ${MAX_CSV_ROWS}-row limit` });
      }

      const result: ImportResponse = {
        imported: 0,
        skippedDuplicate: 0,
        skippedSuppressed: 0,
        rejected: [],
      };

      const toInsert: RawLeadInput[] = [];

      for (let i = 0; i < rawLeads.length; i++) {
        const rowNumber = i + 2; // +1 for 0-index, +1 for the header row
        const validation = validateLeadFields(rawLeads[i]);
        if (!validation.valid) {
          result.rejected.push({ row: rowNumber, reason: validation.reason });
          continue;
        }

        if (await isEmailSuppressed(validation.lead.email)) {
          result.skippedSuppressed += 1;
          continue;
        }
        if (await isDuplicateLead(campaignId, validation.lead.email)) {
          result.skippedDuplicate += 1;
          continue;
        }

        toInsert.push(validation.lead);
      }

      // Chunked batch insert (Phase 2 spec) — createMany with skipDuplicates as a second line of
      // defense against a race between the isDuplicateLead check above and this insert.
      const CHUNK_SIZE = 500;
      for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
        const chunk = toInsert.slice(i, i + CHUNK_SIZE);
        const { count } = await prisma.lead.createMany({
          data: chunk.map((lead) => ({
            campaignId: lead.campaignId,
            email: lead.email,
            firstName: lead.firstName,
            lastName: lead.lastName,
            company: lead.company,
            customFields: lead.customFields as Prisma.InputJsonValue,
            status: 'UNTOUCHED',
          })),
          skipDuplicates: true,
        });
        result.imported += count;
      }

      return reply.send(result);
    },
  );

  app.post<{ Body: ImportRowsBody }>(
    '/import-rows',
    {
      bodyLimit: MAX_CSV_FILE_BYTES * 3,
      config: {
        rateLimit: {
          max: RATE_LIMIT_CSV_IMPORT.max * 3,
          timeWindow: RATE_LIMIT_CSV_IMPORT.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const campaignId = typeof body.campaignId === 'string' ? body.campaignId.trim() : '';
      if (!campaignId)
        return reply.code(422).send({ error: 'Pick the campaign these leads are for' });
      if (!Array.isArray(body.rows)) return reply.code(422).send({ error: 'rows must be a list' });
      if (body.rows.length > MAX_CSV_ROWS) {
        return reply
          .code(413)
          .send({ error: `At most ${MAX_CSV_ROWS.toLocaleString('en-US')} rows per import` });
      }
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { status: true },
      });
      if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
      if (campaign.status === 'ARCHIVED')
        return reply.code(422).send({ error: 'This campaign is archived' });
      const dryRun = body.dryRun === true;
      const skipInOtherCampaigns = body.rules?.skipInOtherCampaigns === true;
      const skipRoleAddresses = body.rules?.skipRoleAddresses === true;

      const result: ImportRowsResult = {
        dryRun,
        total: body.rows.length,
        imported: 0,
        skippedDuplicate: 0,
        skippedSuppressed: 0,
        skippedOtherCampaign: 0,
        skippedRole: 0,
        rejected: [],
      };

      // Validate every row, de-duplicating within the file itself.
      const valid: Array<{ row: number; lead: RawLeadInput & { email: string } }> = [];
      const seenInFile = new Set<string>();
      (body.rows as unknown[]).forEach((raw, i) => {
        const row = i + 2; // +1 for 0-index, +1 for the header row
        const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const text = (value: unknown) =>
          typeof value === 'string' ? value : value == null ? null : String(value);
        const customFields =
          input.customFields &&
          typeof input.customFields === 'object' &&
          !Array.isArray(input.customFields)
            ? Object.fromEntries(
                Object.entries(input.customFields as Record<string, unknown>)
                  .filter(([key]) => key.trim())
                  .map(([key, value]) => [key.trim(), text(value) ?? '']),
              )
            : {};
        const validation = validateLeadFields({
          campaignId,
          email: text(input.email) ?? '',
          firstName: text(input.firstName),
          lastName: text(input.lastName),
          company: text(input.company),
          customFields,
        });
        if (!validation.valid) {
          result.rejected.push({
            row,
            email: text(input.email)?.slice(0, 200) ?? '',
            reason: validation.detail ?? REJECTION_TEXT[validation.reason] ?? validation.reason,
          });
          return;
        }
        if (seenInFile.has(validation.lead.email)) {
          result.skippedDuplicate += 1;
          return;
        }
        seenInFile.add(validation.lead.email);
        if (skipRoleAddresses && isRoleAddress(validation.lead.email)) {
          result.skippedRole += 1;
          return;
        }
        valid.push({ row, lead: validation.lead });
      });

      // One query per 1,000 emails for each rule, rather than one per row.
      const suppressed = new Set<string>();
      const inThisCampaign = new Set<string>();
      const inOtherCampaigns = new Set<string>();
      const emails = valid.map((entry) => entry.lead.email);
      for (let i = 0; i < emails.length; i += 1_000) {
        const batch = emails.slice(i, i + 1_000);
        const [suppressedRows, existingRows] = await Promise.all([
          prisma.suppressionEntry.findMany({
            where: { email: { in: batch } },
            select: { email: true },
          }),
          prisma.lead.findMany({
            where: {
              email: { in: batch },
              ...(skipInOtherCampaigns
                ? { campaign: { status: { not: 'ARCHIVED' } } }
                : { campaignId }),
            },
            select: { email: true, campaignId: true },
          }),
        ]);
        for (const entry of suppressedRows) suppressed.add(entry.email);
        for (const lead of existingRows)
          (lead.campaignId === campaignId ? inThisCampaign : inOtherCampaigns).add(lead.email);
      }

      const toInsert: RawLeadInput[] = [];
      for (const { lead } of valid) {
        if (suppressed.has(lead.email)) result.skippedSuppressed += 1;
        else if (inThisCampaign.has(lead.email)) result.skippedDuplicate += 1;
        else if (skipInOtherCampaigns && inOtherCampaigns.has(lead.email))
          result.skippedOtherCampaign += 1;
        else toInsert.push(lead);
      }

      if (dryRun) {
        result.imported = toInsert.length;
        return reply.send(result);
      }

      const CHUNK_SIZE = 500;
      for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
        const { count } = await prisma.lead.createMany({
          data: toInsert.slice(i, i + CHUNK_SIZE).map((lead) => ({
            campaignId,
            email: lead.email,
            firstName: lead.firstName ?? null,
            lastName: lead.lastName ?? null,
            company: lead.company ?? null,
            customFields: (lead.customFields ?? {}) as Prisma.InputJsonValue,
            status: 'UNTOUCHED',
          })),
          skipDuplicates: true,
        });
        result.imported += count;
      }
      return reply.send(result);
    },
  );

  /** `DELETE /v1/leads/erase` (spec, Guardrails) — bulk GDPR erasure by data-subject email,
   *  distinct from the per-ID hard delete below. "Removes PII, preserves anonymized counts": every
   *  Lead row matching this email (across every campaign in this account — a data-subject erasure
   *  request isn't scoped to one campaign) has its identifying fields overwritten with a
   *  non-reversible placeholder and `piiErasedAt` stamped, but the row itself is KEPT — so
   *  campaign/send/reply aggregate counts that reference it stay accurate, unlike the hard-delete
   *  path which would silently shrink them. Vacuously succeeds (0 erased) if no lead matches;
   *  "nothing to erase" is a valid outcome for a right-to-erasure request, not a 404.
   *
   *  Deliberately does NOT touch `SuppressionEntry` — erasure ("delete my data") and suppression
   *  ("don't email me") are two distinct rights; auto-adding the now-erased address to a table
   *  whose whole purpose is holding a live, checked email would partially defeat the erasure this
   *  endpoint just performed. A lead who wants both should also hit the existing suppress action. */
  app.delete<{ Body: EraseLeadsBody }>('/erase', async (request, reply) => {
    const email = request.body?.email?.trim().toLowerCase();
    if (!email) {
      return reply.code(422).send({ error: 'email is required' });
    }

    const matches = await prisma.lead.findMany({
      where: { email, piiErasedAt: null },
      select: { id: true },
    });

    for (const match of matches) {
      await prisma.lead.update({
        where: { id: match.id },
        data: {
          email: anonymizedEmail(match.id),
          firstName: null,
          lastName: null,
          company: null,
          customFields: Prisma.DbNull,
          // The first email's subject can carry merge-field PII, and an erased lead gets no
          // more follow-ups.
          threadSubject: null,
          nextStepAt: null,
          piiErasedAt: new Date(),
        },
      });
    }

    return reply.send({ email, leadsErased: matches.length });
  });

  /** Guardrails — GDPR right-to-erasure: hard delete, not a status flag. */
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const deleted = await prisma.lead
      .delete({ where: { id: request.params.id } })
      .catch(() => null);
    if (!deleted) return reply.code(404).send({ error: 'Lead not found' });
    return reply.code(204).send();
  });
}
