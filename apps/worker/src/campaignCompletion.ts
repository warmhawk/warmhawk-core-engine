/**
 * Moves a campaign between ACTIVE ("Sending") and COMPLETED ("Completed") by what is left for it
 * to send — the only place either status is set automatically. Runs at the start of every enqueuer
 * tick, so a campaign reads Completed within a tick of its last email going out, and a Completed
 * campaign that gets new work (leads imported, a follow-up added to its sequence) is sending again
 * in the same tick that picks that work up.
 *
 * A PAUSED, DRAFT or ARCHIVED campaign is never touched: Completed only ever replaces Sending.
 */
import { prisma, type Prisma } from '@warmhawk/db';

/** A lead the campaign still owes an email: a first email not sent yet (waiting or queued), or a
 *  follow-up queued or still due. A follow-up on a lead that replied never goes out (the enqueuer
 *  skips it), so it isn't owed. */
export const LEAD_STILL_TO_SEND: Prisma.LeadWhereInput = {
  OR: [
    { status: { in: ['UNTOUCHED', 'QUEUED'] } },
    { status: { in: ['CONTACTED', 'OPENED'] }, queuedJobId: { not: null } },
    { status: { in: ['CONTACTED', 'OPENED'] }, nextStepAt: { not: null }, replies: { none: {} } },
  ],
};

/** Marks Sending campaigns with leads but nothing left to send as Completed, and puts Completed
 *  campaigns that have something to send again back to Sending. A Sending campaign with no leads
 *  at all stays Sending — it's waiting for its first import. */
export async function syncCampaignCompletion(): Promise<{ completed: number; reopened: number }> {
  const completed = await prisma.campaign.updateMany({
    where: { status: 'ACTIVE', leads: { some: {}, none: LEAD_STILL_TO_SEND } },
    data: { status: 'COMPLETED' },
  });
  const reopened = await prisma.campaign.updateMany({
    where: { status: 'COMPLETED', leads: { some: LEAD_STILL_TO_SEND } },
    data: { status: 'ACTIVE' },
  });
  return { completed: completed.count, reopened: reopened.count };
}
