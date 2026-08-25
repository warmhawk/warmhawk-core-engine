/**
 * Internal-only send-trigger — `POST /internal/mail/send`. This is the endpoint the n8n dispatch
 * workflow (`n8n/workflows/dispatch.json`) actually calls to fire an SMTP/OAuth send, after
 * `/internal/ai/personalize` has produced the copy. Ported forward as a genuinely new file (no
 * equivalent existed in this repo until now) — `outreach-infra`'s `mail-relay/send` route is the
 * reference pattern this was modeled on (see `lib/mailSender.ts`'s header comment).
 *
 * Guarded by `requireCallbackSecret` and, per the Containerization Model, reachable ONLY over the
 * internal Docker network — nginx has no location block for `/internal/*` anywhere in this repo.
 */
import type { FastifyInstance } from 'fastify';
import { requireCallbackSecret } from '../lib/requireCallbackSecret';
import { sendMail, MailSendError } from '../lib/mailSender';
import { CanSpamComplianceError } from '../lib/sendCompliance';

interface SendMailBody {
  mailboxId?: string;
  to?: string;
  subject?: string;
  body?: string;
  campaignId?: string;
  leadId?: string;
  countryCode?: string;
  n8nExecutionId?: string;
}

export async function internalMailRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCallbackSecret);

  app.post<{ Body: SendMailBody }>('/send', async (request, reply) => {
    const { mailboxId, to, subject, body, campaignId, leadId, countryCode, n8nExecutionId } =
      request.body;
    if (!mailboxId || !to || !subject || !body) {
      return reply.code(422).send({ error: 'mailboxId, to, subject and body are required' });
    }

    try {
      const result = await sendMail({
        mailboxId,
        to,
        subject,
        body,
        campaignId,
        leadId,
        countryCode,
        n8nExecutionId,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof CanSpamComplianceError) {
        return reply.code(422).send({ error: err.message });
      }
      if (err instanceof MailSendError) {
        return reply
          .code(err.responseCode ?? 502)
          .send({ error: err.message, responseCode: err.responseCode, code: err.code });
      }
      throw err;
    }
  });
}
