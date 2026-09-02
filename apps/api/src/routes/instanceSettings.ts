/**
 * Instance-wide settings — currently just the CAN-SPAM physical mailing address
 * (`InstanceSettings.physicalMailingAddress`), configured once per instance and read by
 * `lib/sendCompliance.ts`'s `assertCanSpamCompliant` gate before any campaign can send.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';

export async function instanceSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => {
    const settings = await prisma.instanceSettings.findUnique({ where: { id: 'default' } });
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
    });
    return updated;
  });
}
