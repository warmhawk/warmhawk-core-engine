/**
 * One full domain check — SPF, DKIM, DMARC and blocklists — shared by the dashboard's on-demand
 * `POST /v1/domains/:domain/check` and the scheduled `POST /internal/domains/check-blocklist`.
 *
 * The scheduled poll used to refresh blocklists only, on the theory that SPF/DKIM/DMARC change
 * only when a customer edits DNS. They also change when a provider rotates or drops a DKIM key or
 * someone else edits the zone, and the badge then stayed green indefinitely while "Last checked"
 * advanced every hour beside it. Every run now re-checks everything, so "Last checked" means what
 * it says and the change-alert diff covers all four fields.
 */
import { prisma, type Domain } from '@warmhawk/db';
import { checkSpf, checkDkim, checkDmarc, checkBlocklists } from './dnsChecks';

/**
 * Runs every check and writes the result. `selectorOverride` (a one-off `?selector=` on the
 * dashboard route) wins over the domain's saved `dkimSelector`.
 */
export async function runDomainCheck(domain: Domain, selectorOverride?: string): Promise<Domain> {
  const selector = selectorOverride || domain.dkimSelector;
  const [spfStatus, dkimStatus, dmarcStatus, blocklistStatus] = await Promise.all([
    checkSpf(domain.domainName),
    checkDkim(domain.domainName, selector),
    checkDmarc(domain.domainName),
    checkBlocklists(domain.domainName),
  ]);

  // History row captures the PRE-update snapshot (`domain.*`, read by the caller before any check
  // ran) — the point is a diff against what this check is about to overwrite, not a copy of the
  // new result. Written in the same transaction as the update so a diff-history reader can never
  // observe the new domain values without the row explaining what they replaced.
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
      data: {
        spfStatus,
        dkimStatus,
        dmarcStatus,
        blocklistStatus,
        lastBlocklistCheckAt: new Date(),
      },
    }),
  ]);
  return updated;
}
