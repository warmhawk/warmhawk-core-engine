/**
 * Free public domain-check tool backend — new, V11 ("the PLG move hiding inside the
 * deliverability feature set... reuses the exact SPF/DKIM/DMARC and blocklist checking logic
 * already built for the paid dashboard, called against an arbitrary unauthenticated domain").
 * `GET /public/domain-check?domain=` — no auth, rate-limited (this is the one route most exposed
 * to abuse/scraping without a rate limit in front of it, per Guardrails).
 *
 * JUDGMENT CALL: the spec lists an "RFC 8058 one-click-unsubscribe header check" alongside
 * SPF/DKIM/DMARC/blocklist for this tool. RFC 8058's `List-Unsubscribe`/`List-Unsubscribe-Post`
 * are headers on an actual SENT EMAIL, not something resolvable from DNS for an arbitrary domain
 * with no message sample — there is nothing to "check" for a bare domain string. This route
 * returns an explanatory `listUnsubscribeCheck` field noting that limitation rather than
 * fabricating a PASS/FAIL a domain-only query can't actually support, so the public tool never
 * claims to verify something it structurally cannot.
 */
import type { FastifyInstance } from 'fastify';
import { checkSpf, checkDkim, checkDmarc, checkBlocklists } from '../lib/dnsChecks';
import { RATE_LIMIT_PUBLIC_DOMAIN_CHECK } from '../../../../constants';

const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export async function publicDomainCheckRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { domain?: string } }>(
    '/domain-check',
    {
      config: {
        rateLimit: {
          max: RATE_LIMIT_PUBLIC_DOMAIN_CHECK.max,
          timeWindow: RATE_LIMIT_PUBLIC_DOMAIN_CHECK.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      const domain = request.query.domain?.trim().toLowerCase();
      if (!domain || !DOMAIN_REGEX.test(domain)) {
        return reply.code(422).send({ error: 'A valid domain query parameter is required' });
      }

      const [spf, dkim, dmarc, blocklists] = await Promise.all([
        checkSpf(domain),
        checkDkim(domain),
        checkDmarc(domain),
        checkBlocklists(domain),
      ]);

      return reply.send({
        domain,
        spf,
        dkim,
        dmarc,
        blocklists,
        listUnsubscribeCheck:
          'RFC 8058 List-Unsubscribe headers are attached to sent messages, not resolvable from ' +
          'DNS for a bare domain — connect this domain in WarmHawk to verify it on real sends.',
      });
    },
  );
}
