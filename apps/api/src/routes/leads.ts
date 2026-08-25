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
 */
import type { FastifyInstance } from 'fastify';
import { parse } from 'csv-parse/sync';
import { prisma, Prisma } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import {
  validateLeadFields,
  isEmailSuppressed,
  isDuplicateLead,
  type RawLeadInput,
} from '../lib/leadIngest';
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

interface ListLeadsQuery {
  campaignId?: string;
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

  /** NEW, additive — warmhawk-enterprise-operator's Leads page (`GET /leads`) and its
   *  import-dialog revalidation call both already assumed this route; it did not exist. Returns
   *  an envelope (not a bare array, unlike domains/campaigns/mailboxes) so the dashboard can show
   *  a total count without a second round trip — matches the shape the operator was already
   *  built against. */
  app.get<{ Querystring: ListLeadsQuery }>('/', async (request) => {
    const { campaignId } = request.query;
    const where = campaignId ? { campaignId } : {};
    const [leads, total] = await Promise.all([
      prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' } }),
      prisma.lead.count({ where }),
    ]);
    return { leads, total };
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

    await prisma.suppressionEntry.upsert({
      where: { email: lead.email },
      create: { email: lead.email, reason: 'Manually suppressed from dashboard', source: 'manual' },
      update: {},
    });
    const updated = await prisma.lead.update({
      where: { id: lead.id },
      data: { status: 'SUPPRESSED' },
    });
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
      const file = await request.file({ limits: { fileSize: MAX_CSV_FILE_BYTES } });
      if (!file) {
        return reply.code(422).send({ error: 'A CSV file field is required' });
      }

      const campaignIdField = file.fields.campaignId;
      const campaignId =
        campaignIdField && 'value' in campaignIdField ? String(campaignIdField.value) : undefined;
      if (!campaignId) {
        return reply.code(422).send({ error: 'campaignId field is required' });
      }

      const buffer = await file.toBuffer();
      if (buffer.byteLength > MAX_CSV_FILE_BYTES) {
        return reply
          .code(413)
          .send({ error: `CSV file exceeds the ${MAX_CSV_FILE_BYTES}-byte limit` });
      }

      let rawLeads: RawLeadInput[];
      try {
        rawLeads = parseLeadsCsv(buffer, campaignId);
      } catch (err) {
        return reply.code(422).send({ error: `Failed to parse CSV: ${(err as Error).message}` });
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
