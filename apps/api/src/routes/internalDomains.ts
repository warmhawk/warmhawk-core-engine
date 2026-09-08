/**
 * Internal-only domain listing + blocklist re-check, mirroring `internalMailboxes.ts`'s pattern —
 * the new `blocklist-poll` n8n scheduled workflow needs to enumerate domains and re-run
 * `checkBlocklists` on each one continuously (domains.ts's own header comment already describes
 * blocklist/DNSBL status as needing "continuous... monitoring", unlike SPF/DKIM/DMARC which only
 * change when a customer edits DNS records and are checked on-demand via the dashboard's
 * `POST /v1/domains/:domain/check`). Deliberately scoped to blocklist status only — this route
 * does not touch spfStatus/dkimStatus/dmarcStatus, so a scheduled poll can never clobber a more
 * recent on-demand full check with a stale/redundant SPF/DKIM/DMARC result.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { requireCallbackSecret } from '../lib/requireCallbackSecret';
import { checkBlocklists } from '../lib/dnsChecks';

interface CheckBlocklistBody {
  domainName?: string;
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
}
