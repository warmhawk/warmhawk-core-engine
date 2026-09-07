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
import { checkSpf, checkDkim, checkDmarc, checkBlocklists } from '../lib/dnsChecks';

interface CreateDomainBody {
  domainName: string;
  redirectUrl?: string;
}

interface CheckDnsQuery {
  selector?: string;
}

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
    const domain = await prisma.domain.create({
      data: {
        domainName: domainName.trim().toLowerCase(),
        redirectUrl: redirectUrl?.trim() || null,
      },
    });
    return reply.code(201).send(domain);
  });

  app.patch<{ Params: { id: string }; Body: { redirectUrl?: string } }>(
    '/:id',
    async (request, reply) => {
      const domain = await prisma.domain
        .update({
          where: { id: request.params.id },
          data: { redirectUrl: request.body.redirectUrl },
        })
        .catch(() => null);
      if (!domain) return reply.code(404).send({ error: 'Domain not found' });
      return domain;
    },
  );

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
   *  call since a customer re-checking a domain wants both signals together, not two round trips. */
  app.post<{ Params: { domain: string }; Querystring: CheckDnsQuery }>(
    '/:domain/check',
    async (request, reply) => {
      const domainName = request.params.domain.trim().toLowerCase();
      const domain = await prisma.domain.findUnique({ where: { domainName } });
      if (!domain) return reply.code(404).send({ error: 'Domain not found' });

      const selector = request.query.selector?.trim() || undefined;
      const [spfStatus, dkimStatus, dmarcStatus, blocklistStatus] = await Promise.all([
        checkSpf(domain.domainName),
        checkDkim(domain.domainName, selector),
        checkDmarc(domain.domainName),
        checkBlocklists(domain.domainName),
      ]);

      const updated = await prisma.domain.update({
        where: { id: domain.id },
        data: { spfStatus, dkimStatus, dmarcStatus, blocklistStatus, lastBlocklistCheckAt: new Date() },
      });
      return updated;
    },
  );

  /**
   * Seed-Inbox Placement Test (Guardrails, V12, option (c)) — aggregated placement-sample results
   * for this domain's own sending mailboxes, surfaced on the domain health dashboard alongside
   * SPF/DKIM/DMARC and blocklist status. A domain has no direct FK to a campaign, so the join
   * path is: this domain's mailboxes -> ExecutionLog rows they actually sent (status SENT) ->
   * those sends' distinct campaignIds -> SeedPlacementResult rows for those campaigns.
   *
   * The response is deliberately, explicitly labeled "placement sampling across N seed inboxes" —
   * per the spec, this must never be marketed or displayed as full inbox-placement testing, the
   * exact overclaiming mistake Competitor Pain Point #1 (Instantly's warmup score) made.
   */
  app.get<{ Params: { id: string } }>('/:id/placement-sample', async (request, reply) => {
    const domain = await prisma.domain.findUnique({ where: { id: request.params.id } });
    if (!domain) return reply.code(404).send({ error: 'Domain not found' });

    const sentLogs = await prisma.executionLog.findMany({
      where: { status: 'SENT', campaignId: { not: null }, mailbox: { domainId: domain.id } },
      select: { campaignId: true },
      distinct: ['campaignId'],
    });
    const campaignIds = sentLogs
      .map((log) => log.campaignId)
      .filter((id): id is string => Boolean(id));

    const results = campaignIds.length
      ? await prisma.seedPlacementResult.findMany({
          where: { campaignId: { in: campaignIds } },
          include: { seedAccount: true, campaign: true },
          orderBy: { checkedAt: 'desc' },
        })
      : [];

    const byFolder: Record<'INBOX' | 'SPAM' | 'PROMOTIONS' | 'UNCLASSIFIED', number> = {
      INBOX: 0,
      SPAM: 0,
      PROMOTIONS: 0,
      UNCLASSIFIED: 0,
    };
    for (const result of results) {
      byFolder[result.folder] += 1;
    }

    const sampledSeedAccountIds = new Set(results.map((r) => r.seedAccountId));
    const totalChecks = results.length;
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
      results: results.slice(0, 50).map((result) => ({
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
