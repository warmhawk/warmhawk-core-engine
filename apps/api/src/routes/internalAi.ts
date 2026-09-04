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
import { personalizeContent, classifyReply, fillMergeFields } from '../lib/aiProviderClient';
import { renderSpintax } from '../lib/spintax';
import { appendEuAiDisclosureIfNeeded } from '../lib/sendCompliance';

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
}

const PERSONALIZATION_RETRY_DELAY_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-once-then-fall-back policy (resolved when real AI calls were wired in): a flaky provider
 *  must never stall a send. One retry after a short delay absorbs a transient blip; a second
 *  failure falls back to the campaign's own template so the send still goes out, un-personalized,
 *  rather than the queue stalling on it. `aiPersonalizationFailed: true` on the response is the
 *  visible flag callers (and, eventually, the dashboard) can key off of. */
export async function personalizeWithFallback(
  request: Parameters<typeof personalizeContent>[0],
  fallbackText: string,
): Promise<{ generatedText: string; aiUsed: boolean; aiPersonalizationFailed: boolean }> {
  try {
    const { generatedText } = await personalizeContent(request);
    return { generatedText, aiUsed: true, aiPersonalizationFailed: false };
  } catch {
    await sleep(PERSONALIZATION_RETRY_DELAY_MS);
    try {
      const { generatedText } = await personalizeContent(request);
      return { generatedText, aiUsed: true, aiPersonalizationFailed: false };
    } catch {
      return { generatedText: fallbackText, aiUsed: false, aiPersonalizationFailed: true };
    }
  }
}

/** Renders the campaign's own literal template for the no-AI-provider / inactive-key fallback
 *  path: merge fields first, then spintax. `{{firstName}}` is itself a balanced `{...}` pair one
 *  level in (`{firstName}`) — `lib/spintax.ts`'s innermost-group regex explicitly excludes that
 *  doubled-brace shape (see its own comment, bug fix 2026-09-04), so `renderSpintax` alone no
 *  longer corrupts an unfilled merge field even if this ran out of order. Filling merge fields
 *  first is kept anyway, both because it's the more obviously correct order and as defense in
 *  depth: it removes every `{{...}}` pair before spintax's regex runs at all, rather than relying
 *  solely on that regex's exclusion. */
export function renderFallbackTemplate(template: string, leadContext: Record<string, unknown>): string {
  const merged = fillMergeFields(template, leadContext);
  return renderSpintax(merged);
}

export async function internalAiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCallbackSecret);

  app.post<{ Body: { campaignId?: string; leadId?: string } }>(
    '/personalize',
    async (request, reply) => {
      const { campaignId, leadId } = request.body;
      if (!campaignId || !leadId) {
        return reply.code(422).send({ error: 'campaignId and leadId are required' });
      }

      const [campaign, lead] = await Promise.all([
        prisma.campaign.findUnique({ where: { id: campaignId } }),
        prisma.lead.findUnique({ where: { id: leadId } }),
      ]);
      if (!campaign || !lead) return reply.code(404).send({ error: 'Campaign or lead not found' });

      const leadContext = {
        firstName: lead.firstName,
        lastName: lead.lastName,
        company: lead.company,
        ...(typeof lead.customFields === 'object' && lead.customFields ? lead.customFields : {}),
      };
      const rawTemplate = campaign.template ?? campaign.aiPromptTemplate;

      if (!campaign.aiProvider) {
        // No provider configured — render the template (merge fields + spintax) rather than
        // failing, and rather than sending it back raw (Phase 3 spec: send as-is is about not
        // failing the send, not about skipping the template's own merge/spintax syntax).
        return reply.send({
          generatedText: renderFallbackTemplate(rawTemplate, leadContext),
          aiUsed: false,
        });
      }

      const providerKey = await prisma.aiProviderKey.findUnique({
        where: { provider: campaign.aiProvider },
      });
      if (!providerKey || !providerKey.isActive) {
        return reply.send({
          generatedText: renderFallbackTemplate(rawTemplate, leadContext),
          aiUsed: false,
        });
      }

      const apiKey = decrypt(providerKey.apiKeyEncrypted, encryptionKey());
      // The AI call's own fallback (a flaky/erroring provider, handled by `personalizeWithFallback`
      // below) must render the same way as the two no-provider branches above — a customer who
      // configured AI but hit a transient outage still deserves merge fields + spintax instead of
      // raw template text.
      const fallbackText = renderFallbackTemplate(rawTemplate, leadContext);
      const { generatedText, aiUsed, aiPersonalizationFailed } = await personalizeWithFallback(
        {
          provider: campaign.aiProvider,
          apiKey,
          model: providerKey.model,
          promptTemplate: campaign.aiPromptTemplate,
          leadContext,
        },
        fallbackText,
      );

      // The EU AI-disclosure marker only applies to actual AI-generated content — a fallback send
      // uses the plain template, so there's nothing to disclose.
      const { body, disclosureAppended } = aiUsed
        ? appendEuAiDisclosureIfNeeded(generatedText, true, {
            email: lead.email,
            countryCode:
              typeof lead.customFields === 'object' && lead.customFields
                ? ((lead.customFields as Record<string, unknown>).countryCode as string | undefined)
                : undefined,
          })
        : { body: generatedText, disclosureAppended: false };

      return reply.send({
        generatedText: body,
        aiUsed,
        aiPersonalizationFailed,
        euAiDisclosureAppended: disclosureAppended,
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
    //
    // The suppression-entry upsert and the lead-status update run in one transaction: previously
    // these were two independent awaits, so a crash or dropped DB connection between them could
    // leave a SuppressionEntry created with the lead still CONTACTED (or, if the second write hit
    // a retry/duplicate classify-reply call, applied out of order) — an inconsistent state where
    // the suppression check elsewhere and this lead's own status row disagree. Both writes are
    // otherwise idempotent (fixed assignments, not read-modify-write), so the transaction's only
    // job is all-or-nothing atomicity, not serializing concurrent classify-reply calls.
    if (classification === 'OPT_OUT') {
      const lead = await prisma.lead.findUnique({ where: { id: replyRow.leadId } });
      if (lead) {
        await prisma.$transaction([
          prisma.suppressionEntry.upsert({
            where: { email: lead.email },
            create: {
              email: lead.email,
              reason: 'Reply opt-out language detected',
              source: 'reply_opt_out',
            },
            update: {},
          }),
          prisma.lead.update({ where: { id: lead.id }, data: { status: 'SUPPRESSED' } }),
        ]);
      }
    }

    return reply.send(updated);
  });
}
