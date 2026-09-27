/**
 * Instance-wide settings — the CAN-SPAM physical mailing address
 * (`InstanceSettings.physicalMailingAddress`), configured once per instance and read by
 * `lib/sendCompliance.ts`'s `assertCanSpamCompliant` gate before any campaign can send.
 *
 * Also `PUT /connect-license` (WarmHawk Connect, 09-27-26): the operator pushes its license token
 * and relay URL here on activate, on every refresh and at boot, so core can call the relay on
 * warmhawk.com (lib/connectRelay.ts). It lives under this already-proxied `/v1` group because the
 * operator reaches core through core's own nginx, which proxies nothing outside `/v1/*`.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { normalizeRelayBaseUrl, saveConnectLicense } from '../lib/connectRelay';

/** Never the Connect license columns: those stay server-side. */
const PUBLIC_FIELDS = { id: true, physicalMailingAddress: true, updatedAt: true } as const;

/** A license token is a signed payload plus an RSA signature — well under this in practice. */
const MAX_LICENSE_TOKEN_LENGTH = 8192;

export async function instanceSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => {
    const settings = await prisma.instanceSettings.findUnique({
      where: { id: 'default' },
      select: PUBLIC_FIELDS,
    });
    return settings ?? { id: 'default', physicalMailingAddress: null };
  });

  app.put<{ Body: { physicalMailingAddress?: string } }>('/', async (request, reply) => {
    const { physicalMailingAddress } = request.body;
    if (!physicalMailingAddress?.trim()) {
      return reply.code(422).send({ error: 'physicalMailingAddress is required (CAN-SPAM)' });
    }
    const updated = await prisma.instanceSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', physicalMailingAddress: physicalMailingAddress.trim() },
      update: { physicalMailingAddress: physicalMailingAddress.trim() },
      select: PUBLIC_FIELDS,
    });
    return updated;
  });

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
