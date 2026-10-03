/**
 * Domain-authentication + blocklist health checker — SPF/DKIM/DMARC checks, extended
 * with continuous blocklist/DNSBL monitoring (V11, new). Requires auth — this is the customer's
 * own management API for their sending domains.
 *
 * Every route that reaches `lib/dnsChecks.ts` requires auth, and that is not incidental: DNS
 * checks are outbound network calls, so an unauthenticated caller here would be spending the
 * customer's own IP reputation against Spamhaus. If a route in this repo ever needs these checks
 * without a session, that is the wrong repo.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { normalizeDkimSelector } from '../lib/dnsChecks';
import { runDomainCheck } from '../lib/domainCheck';

interface CreateDomainBody {
  domainName: string;
  redirectUrl?: string;
  dkimSelector?: string | null;
}

interface UpdateDomainBody {
  redirectUrl?: string;
  dkimSelector?: string | null;
}

const INVALID_SELECTOR_ERROR =
  'dkimSelector must be a DNS label such as "s1" or "abc123" — the part before ._domainkey';

interface CheckDnsQuery {
  selector?: string;
}

interface CheckHistoryQuery {
  limit?: string;
}

const DEFAULT_CHECK_HISTORY_LIMIT = 10;
const MAX_CHECK_HISTORY_LIMIT = 100;

export async function domainsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => {
    const domains = await prisma.domain.findMany({
      include: { _count: { select: { mailboxes: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return domains;
  });

  app.post<{ Body: CreateDomainBody }>('/', async (request, reply) => {
    const { domainName, redirectUrl } = request.body;
    if (!domainName?.trim()) {
      return reply.code(422).send({ error: 'domainName is required' });
    }
    const dkimSelector = normalizeDkimSelector(request.body.dkimSelector);
    if (dkimSelector === undefined) {
      return reply.code(422).send({ error: INVALID_SELECTOR_ERROR });
    }
    const domain = await prisma.domain.create({
      data: {
        domainName: domainName.trim().toLowerCase(),
        redirectUrl: redirectUrl?.trim() || null,
        dkimSelector,
      },
    });
    return reply.code(201).send(domain);
  });

  /** Only the fields present in the body change; `dkimSelector: null` or `""` clears it. */
  app.patch<{ Params: { id: string }; Body: UpdateDomainBody }>('/:id', async (request, reply) => {
    const body = request.body ?? {};
    const data: { redirectUrl?: string; dkimSelector?: string | null } = {
      redirectUrl: body.redirectUrl,
    };
    if ('dkimSelector' in body) {
      const dkimSelector = normalizeDkimSelector(body.dkimSelector);
      if (dkimSelector === undefined) {
        return reply.code(422).send({ error: INVALID_SELECTOR_ERROR });
      }
      data.dkimSelector = dkimSelector;
    }
    const domain = await prisma.domain
      .update({ where: { id: request.params.id }, data })
      .catch(() => null);
    if (!domain) return reply.code(404).send({ error: 'Domain not found' });
    return domain;
  });

  /**
   * Domain deletion — was deliberately absent (see the dashboard's domain-row.tsx comment history)
   * until the dashboard had a confirmation flow worth pointing it at. Mailbox.domain is
   * `onDelete: Cascade` in the schema, so a bare delete would silently take every mailbox on the
   * domain (and their send history) with it — guarded here with a 409 instead, same shape as the
   * other guarded deletes in this codebase (e.g. prod-promote-lock's ownership check): refuse
   * rather than cascade a customer's mailboxes out from under them.
   */
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const domain = await prisma.domain.findUnique({
      where: { id: request.params.id },
      include: { _count: { select: { mailboxes: true } } },
    });
    if (!domain) return reply.code(404).send({ error: 'Domain not found' });

    if (domain._count.mailboxes > 0) {
      return reply.code(409).send({
        error: `Can't delete ${domain.domainName} — it still has ${domain._count.mailboxes} mailbox${domain._count.mailboxes === 1 ? '' : 'es'} attached. Remove them first.`,
      });
    }

    await prisma.domain.delete({ where: { id: domain.id } });
    return reply.code(204).send();
  });

  /** `POST /v1/domains/:domain/check` (spec) — unified SPF/DKIM/DMARC + blocklist check, keyed
   *  by the domain NAME (not the internal id, unlike this file's other routes) since that's the
   *  shape the spec names and the shape a customer thinks in. Replaces what were previously two
   *  separate id-keyed routes (`/:id/check-dns`, `/:id/check-blocklists`) — collapsed into one
   *  call since a customer re-checking a domain wants both signals together, not two round trips.
   *  DKIM looks at `?selector=` if given, else the domain's saved `dkimSelector`, else guesses. */
  app.post<{ Params: { domain: string }; Querystring: CheckDnsQuery }>(
    '/:domain/check',
    async (request, reply) => {
      const domainName = request.params.domain.trim().toLowerCase();
      const domain = await prisma.domain.findUnique({ where: { domainName } });
      if (!domain) return reply.code(404).send({ error: 'Domain not found' });

      const selector = normalizeDkimSelector(request.query.selector);
      if (selector === undefined) return reply.code(422).send({ error: INVALID_SELECTOR_ERROR });
      return runDomainCheck(domain, selector ?? undefined);
    },
  );

  /** `GET /v1/domains/:domain/check-history` — most recent `DomainCheckHistory` snapshots for a
   *  domain, newest first, so a caller can diff what a given check changed instead of only ever
   *  seeing the latest values. Keyed by domain NAME, matching `POST /:domain/check` above.
   *  Intentionally not tier-gated here (this engine has no tier concept — see app.ts); an
   *  operator-side repo is responsible for gating who can call this. */
  app.get<{ Params: { domain: string }; Querystring: CheckHistoryQuery }>(
    '/:domain/check-history',
    async (request, reply) => {
      const domainName = request.params.domain.trim().toLowerCase();
      const domain = await prisma.domain.findUnique({ where: { domainName } });
      if (!domain) return reply.code(404).send({ error: 'Domain not found' });

      const requestedLimit = Number(request.query.limit);
      const limit =
        Number.isFinite(requestedLimit) && requestedLimit > 0
          ? Math.min(Math.trunc(requestedLimit), MAX_CHECK_HISTORY_LIMIT)
          : DEFAULT_CHECK_HISTORY_LIMIT;

      const history = await prisma.domainCheckHistory.findMany({
        where: { domainId: domain.id },
        orderBy: { checkedAt: 'desc' },
        take: limit,
      });
      return reply.send({ domainId: domain.id, domainName: domain.domainName, history });
    },
  );

  /** `GET /v1/domains/:domain/lookalikes` (Item 6) — persisted `LookalikeCandidate` rows for a
   *  domain, as generated + last checked by `POST /internal/domains/scan-lookalikes`. Keyed by
   *  domain NAME, matching `POST /:domain/check` and `GET /:domain/check-history` above.
   *  Intentionally not tier-gated here (see this file's `check-history` route comment, and
   *  `LookalikeCandidate`'s doc comment in schema.prisma) — an operator-side repo is responsible
   *  for gating who can call this. */
  app.get<{ Params: { domain: string } }>('/:domain/lookalikes', async (request, reply) => {
    const domainName = request.params.domain.trim().toLowerCase();
    const domain = await prisma.domain.findUnique({ where: { domainName } });
    if (!domain) return reply.code(404).send({ error: 'Domain not found' });

    const lookalikes = await prisma.lookalikeCandidate.findMany({
      where: { domainId: domain.id },
      select: {
        id: true,
        candidateDomain: true,
        registered: true,
        firstSeenAt: true,
        lastCheckedAt: true,
      },
      orderBy: { candidateDomain: 'asc' },
    });
    return reply.send({ domainId: domain.id, domainName: domain.domainName, lookalikes });
  });

  /**
   * Seed-Inbox Placement Test (Guardrails, V12, option (c)) — aggregated placement-sample results
   * for this domain's own sending mailboxes, surfaced on the domain health dashboard alongside
   * SPF/DKIM/DMARC and blocklist status. Each sampled copy records the mailbox that sent it, and
   * only copies the check has found (or given up on) count. Rows from before 2026-09-27 have no
   * mailbox — they recorded whatever email a seed received last, not the campaign copy — so they
   * are left out rather than reported.
   *
   * The response is deliberately, explicitly labeled "placement sampling across N seed inboxes" —
   * per the spec, this must never be marketed or displayed as full inbox-placement testing, the
   * exact overclaiming mistake Competitor Pain Point #1 (Instantly's warmup score) made.
   */
  app.get<{ Params: { id: string } }>('/:id/placement-sample', async (request, reply) => {
    const domain = await prisma.domain.findUnique({ where: { id: request.params.id } });
    if (!domain) return reply.code(404).send({ error: 'Domain not found' });

    // Counted in the database; only the 50 newest rows are loaded, for the results list.
    const where = { checkedAt: { not: null }, mailbox: { domainId: domain.id } };
    const [folderCounts, seedCounts, results] = await Promise.all([
      prisma.seedPlacementResult.groupBy({ by: ['folder'], where, _count: { _all: true } }),
      prisma.seedPlacementResult.groupBy({ by: ['seedAccountId'], where }),
      prisma.seedPlacementResult.findMany({
        where,
        include: { seedAccount: true, campaign: true },
        orderBy: { checkedAt: 'desc' },
        take: 50,
      }),
    ]);

    const byFolder: Record<'INBOX' | 'SPAM' | 'PROMOTIONS' | 'UNCLASSIFIED', number> = {
      INBOX: 0,
      SPAM: 0,
      PROMOTIONS: 0,
      UNCLASSIFIED: 0,
    };
    for (const row of folderCounts) {
      byFolder[row.folder] = row._count._all;
    }

    const sampledSeedAccountIds = new Set(seedCounts.map((r) => r.seedAccountId));
    const totalChecks = Object.values(byFolder).reduce((sum, n) => sum + n, 0);
    const inboxPlacementRate = totalChecks > 0 ? byFolder.INBOX / totalChecks : null;

    return reply.send({
      domainId: domain.id,
      domainName: domain.domainName,
      label: `Placement sampling across ${sampledSeedAccountIds.size} seed inbox${sampledSeedAccountIds.size === 1 ? '' : 'es'} — not full inbox-placement testing.`,
      sampledSeedAccountCount: sampledSeedAccountIds.size,
      totalChecks,
      byFolder,
      inboxPlacementRate,
      mostRecentCheckAt: results[0]?.checkedAt ?? null,
      results: results.map((result) => ({
        id: result.id,
        campaignId: result.campaignId,
        campaignName: result.campaign.name,
        seedAccountEmail: result.seedAccount.emailAddress,
        seedAccountProvider: result.seedAccount.provider,
        folder: result.folder,
        checkedAt: result.checkedAt,
      })),
    });
  });
}
