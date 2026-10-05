/**
 * Domain-authentication + blocklist health checker — SPF/DKIM/DMARC checks, extended
 * with continuous blocklist/DNSBL monitoring (V11, new). Requires auth — this is the customer's
 * own management API for their sending domains.
 *
 * Every route that reaches `lib/dnsChecks.ts` requires auth, and that is not incidental: DNS
 * checks are outbound network calls, so an unauthenticated caller here would be spending the
 * customer's own IP reputation against Spamhaus. If a route in this repo ever needs these checks
 * without a session, that is the wrong repo.
 *
 * Mailing address (10-03-26): the CAN-SPAM postal address lives on the domain, so an agency's
 * client brands each send their own. Adding a domain never needs one — only launching a campaign
 * that sends from it does (`lib/sendingReadiness.ts`). Clearing an address that live or draft
 * campaigns rely on needs `confirm: true`, since their sends from this domain stop.
 */
import type { FastifyInstance } from 'fastify';
import { Prisma, prisma } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { normalizeDkimSelector } from '../lib/dnsChecks';
import { runDomainCheck } from '../lib/domainCheck';
import { isPersonalMailProvider, personalMailProviderName } from '../lib/personalMailProviders';

interface AddressFields {
  /** "Client or brand" — a free-text note shown under the domain name. */
  label?: string | null;
  /** The address as one block of text (one line per footer line). */
  mailingAddress?: string | null;
  /** The address as the dialog's fields; when given, `mailingAddress` is built from it. */
  mailingAddressParts?: Partial<Record<(typeof ADDRESS_PARTS)[number], unknown>> | null;
}

interface CreateDomainBody extends AddressFields {
  domainName: string;
  redirectUrl?: string;
  dkimSelector?: string | null;
}

interface UpdateDomainBody extends AddressFields {
  redirectUrl?: string;
  dkimSelector?: string | null;
  /** Required to clear an address that campaigns send with. */
  confirm?: boolean;
}

const ADDRESS_PARTS = [
  'businessName',
  'street',
  'suite',
  'city',
  'region',
  'postalCode',
  'country',
] as const;
const MAX_ADDRESS_LENGTH = 500;
const MAX_LABEL_LENGTH = 80;

type AddressPatch = {
  label?: string | null;
  mailingAddress?: string | null;
  mailingAddressParts?: Prisma.InputJsonValue | typeof Prisma.DbNull;
};

/** The address fields of a create/update body, validated. Only the keys present in the body are
 *  returned, so a PATCH without them leaves the address alone. Blank means "no address" (null). */
function parseAddressFields(
  body: AddressFields,
): { ok: true; data: AddressPatch } | { ok: false; error: string } {
  const data: AddressPatch = {};
  if ('label' in body) {
    if (body.label != null && typeof body.label !== 'string')
      return { ok: false, error: 'label must be text' };
    const label = body.label?.trim() || null;
    if (label && label.length > MAX_LABEL_LENGTH)
      return { ok: false, error: `label must be ${MAX_LABEL_LENGTH} characters or fewer` };
    data.label = label;
  }
  if (body.mailingAddressParts != null) {
    if (typeof body.mailingAddressParts !== 'object' || Array.isArray(body.mailingAddressParts)) {
      return { ok: false, error: 'mailingAddressParts must be an object' };
    }
    const parts: Partial<Record<(typeof ADDRESS_PARTS)[number], string>> = {};
    for (const key of ADDRESS_PARTS) {
      const value = body.mailingAddressParts[key];
      if (value != null && typeof value !== 'string')
        return { ok: false, error: `${key} must be text` };
      if (typeof value === 'string' && value.trim())
        parts[key] = value.trim().replace(/\s*\n\s*/g, ' ');
    }
    if (Object.keys(parts).length === 0) {
      data.mailingAddress = null;
      data.mailingAddressParts = Prisma.DbNull;
    } else {
      const missing = (['street', 'city', 'country'] as const).filter((key) => !parts[key]);
      if (missing.length) return { ok: false, error: `The address needs ${missing.join(', ')}` };
      const cityLine = [parts.city, [parts.region, parts.postalCode].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ');
      data.mailingAddress = [
        parts.businessName,
        [parts.street, parts.suite].filter(Boolean).join(', '),
        cityLine,
        parts.country,
      ]
        .filter(Boolean)
        .join('\n');
      data.mailingAddressParts = parts;
    }
  } else if ('mailingAddress' in body || 'mailingAddressParts' in body) {
    if (body.mailingAddress != null && typeof body.mailingAddress !== 'string') {
      return { ok: false, error: 'mailingAddress must be text' };
    }
    data.mailingAddress = body.mailingAddress?.trim() || null;
    data.mailingAddressParts = Prisma.DbNull;
  }
  if (data.mailingAddress && data.mailingAddress.length > MAX_ADDRESS_LENGTH) {
    return {
      ok: false,
      error: `The mailing address must be ${MAX_ADDRESS_LENGTH} characters or fewer`,
    };
  }
  return { ok: true, data };
}

/** Per domain, the non-archived campaigns that send from one of its mailboxes. */
async function campaignUsage(domainIds: string[]) {
  const links = domainIds.length
    ? await prisma.campaignMailbox.findMany({
        where: {
          mailbox: { domainId: { in: domainIds } },
          campaign: { status: { not: 'ARCHIVED' } },
        },
        select: {
          mailbox: { select: { domainId: true } },
          campaign: { select: { id: true, name: true, status: true } },
        },
      })
    : [];
  const usage = new Map<string, Map<string, { id: string; name: string; status: string }>>();
  for (const link of links) {
    const byCampaign = usage.get(link.mailbox.domainId) ?? new Map();
    byCampaign.set(link.campaign.id, link.campaign);
    usage.set(link.mailbox.domainId, byCampaign);
  }
  return (domainId: string) => {
    const campaigns = [...(usage.get(domainId)?.values() ?? [])];
    const count = (status: string) => campaigns.filter((c) => c.status === status).length;
    return {
      campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status })),
      sending: count('ACTIVE'),
      paused: count('PAUSED'),
      drafts: count('DRAFT'),
    };
  };
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
    const usageOf = await campaignUsage(domains.map((domain) => domain.id));
    return domains.map((domain) => ({
      ...domain,
      usedBy: usageOf(domain.id),
      personalProvider: isPersonalMailProvider(domain.domainName),
    }));
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
    const address = parseAddressFields(request.body);
    if (!address.ok) return reply.code(422).send({ error: address.error });
    const name = domainName.trim().toLowerCase();
    if (await prisma.domain.findUnique({ where: { domainName: name } })) {
      return reply.code(409).send({ error: `${name} is already added` });
    }
    const domain = await prisma.domain.create({
      data: {
        domainName: name,
        redirectUrl: redirectUrl?.trim() || null,
        dkimSelector,
        ...address.data,
      },
    });
    return reply.code(201).send({ ...domain, personalProvider: isPersonalMailProvider(name) });
  });

  /** Only the fields present in the body change; `dkimSelector: null` or `""` clears it, and so
   *  does a blank address — with `confirm: true` when campaigns send with it. */
  app.patch<{ Params: { id: string }; Body: UpdateDomainBody }>('/:id', async (request, reply) => {
    const body = request.body ?? {};
    const address = parseAddressFields(body);
    if (!address.ok) return reply.code(422).send({ error: address.error });
    const data: { redirectUrl?: string; dkimSelector?: string | null } & AddressPatch = {
      redirectUrl: body.redirectUrl,
      ...address.data,
    };
    if (address.data.mailingAddress === null && body.confirm !== true) {
      const current = await prisma.domain.findUnique({ where: { id: request.params.id } });
      if (!current) return reply.code(404).send({ error: 'Domain not found' });
      const usage = (await campaignUsage([current.id]))(current.id);
      const live = usage.campaigns.filter((c) => c.status !== 'COMPLETED');
      if (current.mailingAddress?.trim() && live.length > 0) {
        return reply.code(409).send({
          error: `${live.length} campaign${live.length === 1 ? '' : 's'} send${live.length === 1 ? 's' : ''} from ${current.domainName} — without an address its mailboxes stop sending them. Send confirm: true to clear it anyway.`,
          code: 'ADDRESS_IN_USE',
          campaigns: live,
        });
      }
    }
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
    return { ...domain, usedBy: (await campaignUsage([domain.id]))(domain.id) };
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
      if (isPersonalMailProvider(domainName)) {
        return reply.code(422).send({
          error: `DNS for ${domainName} is managed by ${personalMailProviderName(domainName)}, so there's nothing to check`,
        });
      }

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
