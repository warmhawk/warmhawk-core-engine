/**
 * Webhook lead ingest — refactored to call the SHARED `leadIngest.ts` validation function (per the
 * V12 spec: "factor shared validation into leadIngest.ts so both the webhook route and the
 * import route call one function" — previously this validation logic lived only inline here).
 * Rate-limited per the Guardrails section, using `@fastify/rate-limit`'s per-route config.
 */
import type { FastifyInstance } from 'fastify';
import { prisma, Prisma } from '@warmhawk/db';
import {
  validateLeadFields,
  isEmailSuppressed,
  isDuplicateLead,
  type RawLeadInput,
} from '../lib/leadIngest';
import { RATE_LIMIT_WEBHOOK_INGEST } from '../../../../constants';

export async function webhookLeadsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RawLeadInput }>(
    '/',
    {
      config: {
        rateLimit: {
          max: RATE_LIMIT_WEBHOOK_INGEST.max,
          timeWindow: RATE_LIMIT_WEBHOOK_INGEST.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      const body = request.body ?? ({} as RawLeadInput);
      const validation = validateLeadFields(body);

      if (!validation.valid) {
        return reply.code(422).send({ status: 'rejected', reason: validation.reason });
      }

      const { lead } = validation;

      if (await isEmailSuppressed(lead.email)) {
        return reply.code(200).send({ status: 'skipped', reason: 'suppressed' });
      }
      if (await isDuplicateLead(lead.campaignId, lead.email)) {
        return reply.code(200).send({ status: 'skipped', reason: 'duplicate' });
      }

      const created = await prisma.lead.create({
        data: {
          campaignId: lead.campaignId,
          email: lead.email,
          firstName: lead.firstName,
          lastName: lead.lastName,
          company: lead.company,
          customFields: lead.customFields as Prisma.InputJsonValue,
          status: 'UNTOUCHED',
        },
      });

      return reply.code(201).send({ status: 'queued', leadId: created.id });
    },
  );
}
