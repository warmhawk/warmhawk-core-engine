/**
 * Internal-only AI routes — `POST /internal/ai/personalize` (Phase 3) and
 * `POST /internal/ai/classify-reply` (V11, Reply Management & Unified Inbox). Both:
 *   - guarded by `requireCallbackSecret` (never a public route)
 *   - per the Containerization Model, reachable ONLY over the internal Docker network — nginx
 *     has no location block for `/internal/*` anywhere in this repo (see nginx/nginx.conf.template)
 *   - decrypt the customer's BYOK provider key server-side, in this process only — the plaintext
 *     key never reaches n8n's workflow JSON or execution logs, since those get exported/committed
 *   - call `aiProviderClient.ts`, which now makes real provider HTTP requests (API-surface
 *     correction pass)
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { requireCallbackSecret } from '../lib/requireCallbackSecret';
import { decrypt, loadEncryptionKey } from '../lib/encryption';
import { classifyReply } from '../lib/aiProviderClient';
import { composeCampaignEmail, resolveSenderName } from '../lib/composeCampaignEmail';
import { suppressEmail } from '../lib/suppression';

// Moved to `lib/composeCampaignEmail.ts` so the dashboard preview shares them; re-exported for the
// existing callers and tests that import them from here.
export { personalizeWithFallback, renderFallbackTemplate } from '../lib/composeCampaignEmail';

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
}

export async function internalAiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCallbackSecret);

  app.post<{ Body: { campaignId?: string; leadId?: string; mailboxId?: string } }>(
    '/personalize',
    async (request, reply) => {
      const { campaignId, leadId, mailboxId } = request.body;
      if (!campaignId || !leadId) {
        return reply.code(422).send({ error: 'campaignId and leadId are required' });
      }

      const [campaign, lead, mailbox] = await Promise.all([
        prisma.campaign.findUnique({ where: { id: campaignId } }),
        prisma.lead.findUnique({ where: { id: leadId } }),
        // `mailboxId` is optional so a dispatch workflow from before it was sent still works; with
        // none, `{{senderName}}` is simply left for the model / template to do without.
        mailboxId
          ? prisma.mailbox.findUnique({ where: { id: mailboxId }, select: { email: true, senderName: true } })
          : null,
      ]);
      if (!campaign || !lead) return reply.code(404).send({ error: 'Campaign or lead not found' });

      // No provider, an inactive key, and a provider that fails twice all send the campaign's own
      // email rendered (merge fields + spintax) — never raw template text, never a stalled send.
      // The EU AI-disclosure marker is appended only to actual AI-written copy.
      const composed = await composeCampaignEmail({ campaign, lead, senderName: resolveSenderName(mailbox) });

      return reply.send({
        // `generatedText` keeps the old single-string shape (subject line, newline, body) for a
        // dispatch workflow that still splits on the first newline itself.
        generatedText: `${composed.subject}\n${composed.body}`,
        subject: composed.subject,
        body: composed.body,
        aiUsed: composed.aiOutcome === 'AI_WRITTEN',
        aiPersonalizationFailed: composed.aiOutcome === 'AI_FALLBACK',
        aiOutcome: composed.aiOutcome,
        aiFallbackReason: composed.aiFallbackReason,
        euAiDisclosureAppended: composed.euAiDisclosureAppended,
      });
    },
  );

  app.post<{ Body: { replyId?: string } }>('/classify-reply', async (request, reply) => {
    const { replyId } = request.body;
    if (!replyId) return reply.code(422).send({ error: 'replyId is required' });

    const replyRow = await prisma.reply.findUnique({
      where: { id: replyId },
      include: { campaign: true },
    });
    if (!replyRow) return reply.code(404).send({ error: 'Reply not found' });

    const provider =
      replyRow.campaign.aiProvider ??
      (await prisma.aiProviderKey.findFirst({ where: { isActive: true } }))?.provider;

    let classification: Awaited<ReturnType<typeof classifyReply>>['classification'] =
      'UNCLASSIFIED';

    if (provider) {
      const providerKey = await prisma.aiProviderKey.findUnique({ where: { provider } });
      if (providerKey?.isActive) {
        const apiKey = decrypt(providerKey.apiKeyEncrypted, encryptionKey());
        const result = await classifyReply({
          provider,
          apiKey,
          model: providerKey.model,
          replyContent: replyRow.rawContent,
        });
        classification = result.classification;
      }
    }

    const updated = await prisma.reply.update({
      where: { id: replyId },
      data: { classification, classifiedAt: new Date() },
    });

    // Guardrails — "opt-out language detected in reply threads auto-suppresses the lead." This
    // IS that requirement, made real: the classification call above is what makes it happen, not
    // a separate background workflow.
    if (classification === 'OPT_OUT') {
      const lead = await prisma.lead.findUnique({ where: { id: replyRow.leadId } });
      if (lead) {
        await suppressEmail(lead.email, {
          source: 'reply_opt_out',
          reason: 'Reply opt-out language detected',
        });
      }
    }

    return reply.send(updated);
  });
}
