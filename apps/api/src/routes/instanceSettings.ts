/**
 * Instance-wide settings. The CAN-SPAM mailing address used to live here, once per install; since
 * 10-03-26 it is per domain (`Domain.mailingAddress`, `routes/domains.ts`) so each client brand
 * sends its own, and `PUT /` answers 410. The old column stays in the database, unread.
 *
 * Also `PUT /connect-license` (WarmHawk Connect, 09-27-26): the operator pushes its license token
 * and relay URL here on activate, on every refresh and at boot, so core can call the relay on
 * warmhawk.com (lib/connectRelay.ts). It lives under this already-proxied `/v1` group because the
 * operator reaches core through core's own nginx, which proxies nothing outside `/v1/*`.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../lib/requireAuth';
import { normalizeRelayBaseUrl, saveConnectLicense } from '../lib/connectRelay';

/** A license token is a signed payload plus an RSA signature — well under this in practice. */
const MAX_LICENSE_TOKEN_LENGTH = 8192;

export async function instanceSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // `builtInUnsubscribe`: whether a campaign with no unsubscribe URL of its own gets the built-in
  // page (lib/unsubscribeToken.ts) — the dashboard uses it to say the field is optional.
  app.get('/', async () => ({
    id: 'default',
    builtInUnsubscribe: Boolean(process.env.WARMHAWK_DOMAIN?.trim()),
  }));

  app.put('/', async (_request, reply) =>
    reply.code(410).send({
      error:
        'The mailing address is now set per domain — PATCH /v1/domains/:id with mailingAddress',
    }),
  );

  // Operator service token only: a dashboard user's JWT can't point this install's license at
  // another relay.
  app.put<{ Body: { licenseToken?: unknown; relayBaseUrl?: unknown } }>(
    '/connect-license',
    async (request, reply) => {
      if (request.user?.sub !== 'operator-service') {
        return reply.code(403).send({ error: 'Only the WarmHawk dashboard can set this' });
      }
      const { licenseToken, relayBaseUrl } = request.body ?? {};
      const relay = typeof relayBaseUrl === 'string' ? normalizeRelayBaseUrl(relayBaseUrl) : null;
      if (
        typeof licenseToken !== 'string' ||
        !licenseToken.trim() ||
        licenseToken.length > MAX_LICENSE_TOKEN_LENGTH ||
        !relay
      ) {
        return reply
          .code(422)
          .send({ error: 'licenseToken and an https relayBaseUrl origin are required' });
      }
      await saveConnectLicense(licenseToken.trim(), relay);
      return reply.code(204).send();
    },
  );
}
