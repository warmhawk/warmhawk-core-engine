/**
 * Internal-only reply-poll endpoints — split out of `routes/replies.ts` (V12 fix). Both are
 * machine-to-machine, called only by the n8n `reply-poll` workflow, guarded by
 * `requireCallbackSecret` rather than dashboard JWT. Previously mounted under the public `/v1`
 * group despite that intent (reachable through nginx like any other `/v1/*` route, relying on the
 * callback secret alone rather than network isolation); now mounted at `/internal/replies`,
 * matching every other internal route in this repo (nginx has no location block for `/internal/*`
 * anywhere in this repo's nginx config, so these are unreachable from outside the Docker network
 * by omission, not by a rule that could be misconfigured).
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { requireCallbackSecret } from '../lib/requireCallbackSecret';

interface CreateReplyBody {
  leadId: string;
  campaignId: string;
  mailboxId: string;
  rawContent: string;
  repliedAt?: string;
}

export async function internalRepliesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCallbackSecret);

  /**
   * The n8n `reply-poll` workflow's correlation source: which CONTACTED leads sent via
   * `mailboxId` are still awaiting a reply, and what provider Message-ID to thread IMAP replies
   * against. WarmHawk's `Lead` has no direct mailbox FK (only `ExecutionLog` links lead +
   * mailbox), so this joins through the most recent SENT `ExecutionLog` per lead on that mailbox.
   * Correlation is by Message-ID (IMAP In-Reply-To/References header search, see `routes/imap.ts`)
   * rather than subject text — `payloadSent` deliberately stops short of persisting the sent
   * subject/body (privacy fix, see `lib/mailSender.ts`), and Message-ID is the RFC 5322-standard
   * way mail clients thread a reply regardless.
   */
  app.get<{ Querystring: { mailboxId?: string } }>('/pending', async (request, reply) => {
    const { mailboxId } = request.query;
    if (!mailboxId) return reply.code(422).send({ error: 'mailboxId is required' });

    const sentLogs = await prisma.executionLog.findMany({
      where: { mailboxId, status: 'SENT', campaignId: { not: null }, leadId: { not: null } },
      orderBy: { createdAt: 'asc' },
      include: { lead: true },
    });

    // One entry per lead, with every Message-ID in its thread (first email, then each follow-up)
    // — a reply to any of them is a reply. `providerMessageId` carries them space-separated for
    // the reply-poll workflow, which passes it straight to `/internal/imap/search`.
    const byLead = new Map<
      string,
      { leadId: string; campaignId: string; email: string; providerMessageIds: string[] }
    >();
    for (const log of sentLogs) {
      if (!log.leadId || !log.campaignId || !log.lead) continue;
      // Already replied/bounced/suppressed. OPENED still waits on a reply like CONTACTED does.
      if (log.lead.status !== 'CONTACTED' && log.lead.status !== 'OPENED') continue;
      if (!log.providerMessageId) continue; // sent before this field existed, or send failed
      const entry = byLead.get(log.leadId) ?? {
        leadId: log.leadId,
        campaignId: log.campaignId,
        email: log.lead.email,
        providerMessageIds: [],
      };
      entry.providerMessageIds.push(log.providerMessageId);
      byLead.set(log.leadId, entry);
    }
    const candidates = [...byLead.values()].map((c) => ({
      ...c,
      providerMessageId: c.providerMessageIds.join(' '),
    }));

    // A single batched existence check instead of one `reply.findFirst` round-trip per candidate
    // (was a sequential N+1 inside the loop above — on a mailbox with thousands of CONTACTED
    // leads this workflow polls every few minutes, that meant thousands of sequential DB
    // round-trips per poll).
    const existingReplyLeadIds = candidates.length
      ? new Set(
          (
            await prisma.reply.findMany({
              where: { leadId: { in: candidates.map((c) => c.leadId) } },
              select: { leadId: true },
            })
          ).map((r) => r.leadId),
        )
      : new Set<string>();

    const pending = candidates.filter((c) => !existingReplyLeadIds.has(c.leadId));

    return reply.send({ pending });
  });

  /** Called by the reply-poll workflow after `imap.ts`'s `/fetch-reply` retrieves a message body. */
  app.post<{ Body: CreateReplyBody }>('/', async (request, reply) => {
    const { leadId, campaignId, mailboxId, rawContent, repliedAt } = request.body;
    if (!leadId || !campaignId || !mailboxId || !rawContent) {
      return reply
        .code(422)
        .send({ error: 'leadId, campaignId, mailboxId, rawContent are required' });
    }
    const created = await prisma.reply.create({
      data: {
        leadId,
        campaignId,
        mailboxId,
        rawContent,
        repliedAt: repliedAt ? new Date(repliedAt) : new Date(),
      },
    });
    // A reply ends the lead's sequence: no follow-up goes to someone who answered. Only from a
    // waiting state — a reply that lands after an unsubscribe or bounce doesn't undo either.
    await prisma.lead.updateMany({
      where: { id: leadId, status: { in: ['CONTACTED', 'OPENED', 'QUEUED'] } },
      data: { status: 'REPLIED', nextStepAt: null, nextRetryAt: null },
    });
    return reply.code(201).send(created);
  });
}
