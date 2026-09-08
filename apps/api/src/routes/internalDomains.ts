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
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { requireCallbackSecret } from '../lib/requireCallbackSecret';
import { checkBlocklists } from '../lib/dnsChecks';
import { postDomainChangeAlert } from '../lib/alertWebhook';

interface CheckBlocklistBody {
  domainName?: string;
}

interface NotifyChangesBody {
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

  app.get('/active', async () => {
    const domains = await prisma.domain.findMany({
      select: { domainName: true },
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
}
