/**
 * What a reply does to its lead's follow-ups, once it has a label.
 *
 * A reply stops the sequence the moment it arrives (`routes/internalReplies.ts` marks the lead
 * REPLIED before anything reads it), so nothing goes out to someone who may have answered. The
 * label then decides whether it stays stopped:
 *
 *   - OUT_OF_OFFICE: the follow-ups wait. The next one is due the day after the return date the
 *     reply names (`lib/returnDate.ts`), or a week after the reply when it names none, and never
 *     earlier than the sequence had it.
 *   - AUTO_REPLY (a ticket number, "we'll get back to you"): a machine answered, not the person,
 *     so the sequence carries on as scheduled.
 *   - Everything else, LEFT_COMPANY included: the sequence stays stopped.
 *
 * A lead with any reply that stops it stays stopped, whatever later auto-replies say. Relabelling
 * a reply in the dashboard runs this again, so the lead follows the label it ends up with.
 */
import { prisma, type Prisma, type ReplyClassification } from '@warmhawk/db';
import { nextStepAtAfter } from './sequence';
import { parseReturnDate } from './returnDate';
import { stripQuotedReply } from './replyText';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long an away notice with no readable return date holds the follow-ups. */
export const AWAY_DEFAULT_DAYS = 7;

/** Labels for a machine's answer that leaves the sequence running. */
export const SEQUENCE_KEEPING_CLASSIFICATIONS = [
  'OUT_OF_OFFICE',
  'AUTO_REPLY',
] as const satisfies readonly ReplyClassification[];

/** A reply that ends its lead's sequence: anything but an away notice or an auto-reply. A reply
 *  not labelled yet counts, so nothing is sent while it waits for its label. */
export const SEQUENCE_ENDING_REPLY: Prisma.ReplyWhereInput = {
  classification: { notIn: [...SEQUENCE_KEEPING_CLASSIFICATIONS] },
};

/** Leads still waiting on an answer; a reply that stops the sequence moves them to REPLIED. */
const WAITING = ['CONTACTED', 'OPENED', 'QUEUED'] as const;

export function keepsSequence(classification: ReplyClassification): boolean {
  return (SEQUENCE_KEEPING_CLASSIFICATIONS as readonly string[]).includes(classification);
}

/** When an away notice lets the follow-ups start again: the day after the return date it names,
 *  or a week after it arrived. */
export function awayUntil(rawContent: string, repliedAt: Date): Date {
  const back = parseReturnDate(stripQuotedReply(rawContent), repliedAt);
  return back
    ? new Date(back.getTime() + DAY_MS)
    : new Date(repliedAt.getTime() + AWAY_DEFAULT_DAYS * DAY_MS);
}

export type ReplyOutcome = 'stopped' | 'resumed' | 'paused' | 'unchanged';

/** Applies a labelled reply to its lead (see the header). Safe to run more than once. */
export async function applyReplyOutcome(replyId: string): Promise<ReplyOutcome> {
  const reply = await prisma.reply.findUnique({
    where: { id: replyId },
    include: { lead: true },
  });
  if (!reply?.lead) return 'unchanged';
  const { lead } = reply;

  // BOUNCED and OPT_OUT moved the lead themselves (BOUNCED, SUPPRESSED); this only touches a lead
  // still waiting, so it never undoes either.
  if (!keepsSequence(reply.classification)) {
    const moved = await prisma.lead.updateMany({
      where: { id: lead.id, status: { in: [...WAITING] } },
      data: { status: 'REPLIED', nextStepAt: null, nextRetryAt: null },
    });
    return moved.count > 0 ? 'stopped' : 'unchanged';
  }

  if (lead.status !== 'REPLIED' && lead.status !== 'CONTACTED' && lead.status !== 'OPENED') {
    return 'unchanged';
  }
  const replies = await prisma.reply.findMany({
    where: { leadId: lead.id },
    select: { classification: true, rawContent: true, repliedAt: true },
  });
  if (replies.some((r) => !keepsSequence(r.classification))) return 'unchanged';

  // A stopped lead had its next follow-up cleared, so it's worked out again from the last send. A
  // lead still running keeps its own (null when something else ended the sequence on purpose).
  const scheduled =
    lead.status !== 'REPLIED'
      ? lead.nextStepAt
      : lead.stepsSent > 0 && lead.lastStepAt
        ? nextStepAtAfter(
            await prisma.campaignStep.findMany({
              where: { campaignId: lead.campaignId },
              select: { position: true, waitDays: true },
            }),
            lead.stepsSent,
            lead.lastStepAt,
          )
        : null;
  // Every away notice on the lead holds the follow-ups, so a later ticket auto-reply doesn't cut
  // an earlier "back on the 20th" short. With no follow-up left, there's nothing to hold.
  const holds = replies
    .filter((r) => r.classification === 'OUT_OF_OFFICE')
    .map((r) => awayUntil(r.rawContent, r.repliedAt).getTime());
  const nextStepAt =
    scheduled && holds.length > 0 ? new Date(Math.max(scheduled.getTime(), ...holds)) : scheduled;
  const held = nextStepAt !== null && scheduled !== null && nextStepAt > scheduled;

  const opened =
    lead.status === 'OPENED' ||
    (lead.status === 'REPLIED' &&
      (await prisma.executionLog.count({ where: { leadId: lead.id, status: 'OPENED' } })) > 0);
  const moved = await prisma.lead.updateMany({
    where: { id: lead.id, status: lead.status },
    data: { status: opened ? 'OPENED' : 'CONTACTED', nextStepAt, nextRetryAt: null },
  });
  if (moved.count === 0) return 'unchanged';
  return held ? 'paused' : 'resumed';
}

/**
 * Resumes every lead an away notice or auto-reply stopped before those stopped stopping it: still
 * REPLIED, and every reply on it is one of the two. Each goes through `applyReplyOutcome` with its
 * latest reply. `dryRun` only counts them. Run by `warmhawk replies resume-auto-replied`.
 */
export async function resumeAutoRepliedLeads(
  dryRun: boolean,
): Promise<{ found: number; paused: number; resumed: number }> {
  const leads = await prisma.lead.findMany({
    where: {
      status: 'REPLIED',
      replies: { some: {}, none: SEQUENCE_ENDING_REPLY },
    },
    select: {
      id: true,
      replies: { orderBy: { repliedAt: 'desc' }, take: 1, select: { id: true } },
    },
  });
  const result = { found: leads.length, paused: 0, resumed: 0 };
  if (dryRun) return result;
  for (const lead of leads) {
    const latest = lead.replies[0];
    if (!latest) continue;
    const outcome = await applyReplyOutcome(latest.id);
    if (outcome === 'paused') result.paused += 1;
    if (outcome === 'resumed') result.resumed += 1;
  }
  return result;
}
