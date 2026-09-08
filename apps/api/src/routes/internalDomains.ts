/**
 * Internal-only domain listing + blocklist re-check, mirroring `internalMailboxes.ts`'s pattern —
 * the new `blocklist-poll` n8n scheduled workflow needs to enumerate domains and re-run
 * `checkBlocklists` on each one continuously (domains.ts's own header comment already describes
 * blocklist/DNSBL status as needing "continuous... monitoring", unlike SPF/DKIM/DMARC which only
 * change when a customer edits DNS records and are checked on-demand via the dashboard's
 * `POST /v1/domains/:domain/check`). Deliberately scoped to blocklist status only — this route
 * does not touch spfStatus/dkimStatus/dmarcStatus, so a scheduled poll can never clobber a more
 * recent on-demand full check with a stale/redundant SPF/DKIM/DMARC result.
 *
 * Also holds `POST /notify-changes` (Item 5, Tier-2-only alert routing) — reads back the
 * `DomainCheckHistory` rows this file's `/check-blocklist` route (and domains.ts's
 * `/:domain/check`) write, and fires `lib/alertWebhook.ts#postDomainChangeAlert` for any field
 * that changed. See that route's own doc comment for the history-vs-history diffing rationale.
 *
 * Also holds `POST /scan-lookalikes` (Item 6, Tier-2-only lookalike/typosquat domain monitoring —
 * see `LookalikeCandidate` in schema.prisma for the full feature). Tier-agnostic here by this
 * repo's own convention (no tier concept lives in core-engine — see app.ts / domains.ts's
 * check-history route comment); the sibling operator repo is responsible for gating who's allowed
 * to trigger a scan.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { requireCallbackSecret } from '../lib/requireCallbackSecret';
import { checkBlocklists } from '../lib/dnsChecks';
import { postDomainChangeAlert } from '../lib/alertWebhook';
import { generateCandidates } from '../lib/lookalikeCandidates';
import { checkRdapRegistration } from '../lib/rdap';

interface CheckBlocklistBody {
  domainName?: string;
}

interface NotifyChangesBody {
  domainId?: string;
}

interface ScanLookalikesBody {
  domainId?: string;
}

/** The four `DomainCheckHistory` fields a caller can meaningfully diff. `blocklistStatus` is a
 *  Json blob (see schema.prisma), not a scalar enum like the other three — stringified below so
 *  every field can be compared and reported the same way. */
const COMPARABLE_FIELDS = ['spfStatus', 'dkimStatus', 'dmarcStatus', 'blocklistStatus'] as const;

function stringifyFieldValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

export async function internalDomainsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCallbackSecret);

  // `id` added alongside `domainName` (Item 6) so `n8n/workflows/lookalike-scan.json` can chain
  // straight into `POST /scan-lookalikes` (which is keyed by domainId, not domainName — see that
  // route below) without an extra side-effecting call just to resolve one from the other. Purely
  // additive: `blocklist-poll.json`'s existing "Get Active Domains" node only ever reads
  // `domainName` off each item, so this doesn't change that workflow's behavior.
  app.get('/active', async () => {
    const domains = await prisma.domain.findMany({
      select: { id: true, domainName: true },
      orderBy: { domainName: 'asc' },
    });
    return { domains };
  });

  app.post<{ Body: CheckBlocklistBody }>('/check-blocklist', async (request, reply) => {
    const domainName = request.body?.domainName?.trim().toLowerCase();
    if (!domainName) {
      return reply.code(422).send({ error: 'domainName is required' });
    }
    const domain = await prisma.domain.findUnique({ where: { domainName } });
    if (!domain) return reply.code(404).send({ error: 'Domain not found' });

    const blocklistStatus = await checkBlocklists(domain.domainName);

    // Same pre-update-snapshot pattern as `POST /v1/domains/:domain/check` (domains.ts) — the
    // history row records the values this write is about to replace. spfStatus/dkimStatus/
    // dmarcStatus are untouched by this route, so the snapshot's copy of them is also its final
    // copy (no separate "new" value to diff against for those three fields from this call).
    const [, updated] = await prisma.$transaction([
      prisma.domainCheckHistory.create({
        data: {
          domainId: domain.id,
          spfStatus: domain.spfStatus,
          dkimStatus: domain.dkimStatus,
          dmarcStatus: domain.dmarcStatus,
          blocklistStatus: domain.blocklistStatus ?? undefined,
        },
      }),
      prisma.domain.update({
        where: { id: domain.id },
        data: { blocklistStatus, lastBlocklistCheckAt: new Date() },
      }),
    ]);
    return updated;
  });

  /**
   * `POST /internal/domains/notify-changes` (Item 5 — Tier-2-only alert routing) — reads the two
   * most recent `DomainCheckHistory` rows for a domain and fires one `postDomainChangeAlert` call
   * per field that differs between them.
   *
   * Diffing history-vs-history (not the domain's *current* live values vs. its single most recent
   * history row) is the deliberate choice here, for two reasons:
   *
   *  1. Self-contained correctness: this route can be called any amount of time after the check
   *     that produced the history row it's meant to report on. In that window, a DIFFERENT check
   *     (the customer-facing `POST /v1/domains/:domain/check`, or another scheduled blocklist-poll
   *     tick) can race in and move the domain's *current* live values past what this call is
   *     actually meant to report — diffing against "current" would then either double-report a
   *     later check's changes under this call, or silently attribute them to the wrong check.
   *     Two history rows are an immutable, already-committed pair — nothing about them can change
   *     out from under this comparison after the fact.
   *  2. It matches how history rows are actually written: each is a PRE-update snapshot (see
   *     domains.ts / this file's check-blocklist route above), so the newest row already equals
   *     "the domain's values right after the previous check" and the second-newest equals "right
   *     before the previous check" — comparing them is exactly the diff that previous check
   *     produced, with no dependency on when this route happens to be called.
   *
   *  Trade-off, stated plainly: this lags whatever the MOST RECENT check just did by one full
   *  cycle (it reports check N-1's diff, not check N's, until check N's own successor writes the
   *  next history row) — acceptable for a Tier-2 white-glove alert on an hourly poll, not
   *  acceptable if this were ever repurposed for real-time alerting.
   *
   *  Fewer than 2 history rows (a brand-new domain, or one checked only once) means there is
   *  nothing yet to diff — no-op, not an error.
   */
  app.post<{ Body: NotifyChangesBody }>('/notify-changes', async (request, reply) => {
    const domainId = request.body?.domainId?.trim();
    if (!domainId) {
      return reply.code(422).send({ error: 'domainId is required' });
    }
    const domain = await prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) return reply.code(404).send({ error: 'Domain not found' });

    const [latest, previous] = await prisma.domainCheckHistory.findMany({
      where: { domainId },
      orderBy: { checkedAt: 'desc' },
      take: 2,
    });

    if (!latest || !previous) {
      return reply.send({ domainId, notified: 0 });
    }

    let notified = 0;
    for (const field of COMPARABLE_FIELDS) {
      const before = stringifyFieldValue(previous[field]);
      const after = stringifyFieldValue(latest[field]);
      if (before === after) continue;
      await postDomainChangeAlert({ domain: domain.domainName, field, before, after });
      notified += 1;
    }

    return reply.send({ domainId, notified });
  });

  /**
   * `POST /internal/domains/scan-lookalikes` (Item 6) — driven daily by
   * `n8n/workflows/lookalike-scan.json`.
   *
   * First run for a domain: no `LookalikeCandidate` rows exist yet, so this generates the full
   * candidate list via `generateCandidates()` and bulk-inserts it (`registered: false`,
   * `firstSeenAt`/`lastCheckedAt` defaulting to now via the schema). `generateCandidates()` is
   * pure/deterministic — regenerating it on every scan would just recreate the same rows (and,
   * absent the `@@unique([domainId, candidateDomain])` guard, duplicate them) — so the candidate
   * list is generated exactly once, here, and every later scan only re-checks the rows already on
   * file.
   *
   * Every scan (first run and every one after): for each candidate NOT already `registered: true`,
   * `checkRdapRegistration()` decides what happens next:
   *   - `"registered"` — a NEW registration (this row was not registered as of the last check).
   *     Flip `registered: true`, bump `lastCheckedAt`, and fire `postDomainChangeAlert` — this is
   *     the actionable signal the whole feature exists for.
   *   - `"unregistered"` — still unregistered. Bump `lastCheckedAt` only.
   *   - `"unknown"` — RDAP gave no conclusive answer (network error, timeout, no RDAP server for
   *     that TLD, etc.). Bump `lastCheckedAt` only — do NOT flip `registered` and do NOT alert. An
   *     inconclusive check is not new information, and treating it as "still unregistered" would
   *     risk exactly the false "safe" reading `lib/rdap.ts`'s own doc comment warns against.
   *
   * A candidate already `registered: true` from a prior scan is skipped entirely — RDAP is not
   * even queried for it. Per the doc: a candidate that's been registered for years and never used
   * offensively is not new information; only the unregistered -> registered transition matters.
   */
  app.post<{ Body: ScanLookalikesBody }>('/scan-lookalikes', async (request, reply) => {
    const domainId = request.body?.domainId?.trim();
    if (!domainId) {
      return reply.code(422).send({ error: 'domainId is required' });
    }
    const domain = await prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) return reply.code(404).send({ error: 'Domain not found' });

    const existingCount = await prisma.lookalikeCandidate.count({ where: { domainId } });
    if (existingCount === 0) {
      const generated = generateCandidates(domain.domainName);
      if (generated.length > 0) {
        await prisma.lookalikeCandidate.createMany({
          data: generated.map((candidateDomain) => ({ domainId, candidateDomain })),
          skipDuplicates: true,
        });
      }
    }

    const totalCandidateCount = await prisma.lookalikeCandidate.count({ where: { domainId } });
    const candidates = await prisma.lookalikeCandidate.findMany({
      where: { domainId, registered: false },
    });

    let checked = 0;
    let newlyRegistered = 0;
    for (const candidate of candidates) {
      const result = await checkRdapRegistration(candidate.candidateDomain);
      checked += 1;

      if (result === 'registered') {
        await prisma.lookalikeCandidate.update({
          where: { id: candidate.id },
          data: { registered: true, lastCheckedAt: new Date() },
        });
        await postDomainChangeAlert({
          domain: domain.domainName,
          field: 'lookalike_registered',
          before: 'unregistered',
          after: candidate.candidateDomain,
        });
        newlyRegistered += 1;
      } else if (result === 'unregistered') {
        await prisma.lookalikeCandidate.update({
          where: { id: candidate.id },
          data: { lastCheckedAt: new Date() },
        });
      } else {
        // "unknown" — inconclusive RDAP check. Bump lastCheckedAt only; never flip `registered`
        // and never alert on a non-answer.
        await prisma.lookalikeCandidate.update({
          where: { id: candidate.id },
          data: { lastCheckedAt: new Date() },
        });
      }
    }

    return reply.send({
      domainId,
      candidateCount: totalCandidateCount,
      checked,
      newlyRegistered,
    });
  });
}
