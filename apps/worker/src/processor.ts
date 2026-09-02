/**
 * BullMQ job processor — re-checks mailbox eligibility at dispatch time (a mailbox can be
 * paused/capped between enqueue and the job actually firing, given the jittered delay), then hands
 * off the real send to the n8n dispatch workflow over the internal Docker network — this process
 * never talks to an SMTP server directly.
 */
import type { Job } from 'bullmq';
import { prisma } from '@warmhawk/db';

export interface DispatchJobData {
  leadId: string;
  mailboxId: string;
}

function n8nBaseUrl(): string {
  return process.env.N8N_BASE_URL || 'http://n8n:5678';
}

export async function processDispatchJob(data: DispatchJobData): Promise<void> {
  const { leadId, mailboxId } = data;

  const [mailbox, lead] = await Promise.all([
    prisma.mailbox.findUnique({ where: { id: mailboxId } }),
    prisma.lead.findUnique({ where: { id: leadId } }),
  ]);
  const stillEligible =
    mailbox && lead && mailbox.status === 'ACTIVE' && mailbox.sentToday < mailbox.dailyCap;

  if (!stillEligible) {
    // Revert the lead to UNTOUCHED so the enqueuer re-picks it up against a different mailbox on
    // its next tick, rather than silently dropping it.
    await prisma.lead.updateMany({
      where: { id: leadId, status: 'QUEUED' },
      data: { status: 'UNTOUCHED', queuedJobId: null, queuedSlotAt: null },
    });
    return;
  }

  // The webhook body carries everything n8n's dispatch workflow needs to complete the send
  // without a separate context-fetch round trip: leadId/campaignId (for `/internal/ai/personalize`
  // and the compliance/BCC hooks inside `/internal/mail/send`), mailboxId (the sender), and the
  // recipient's email address (n8n has no direct Postgres access of its own in this repo's design —
  // see n8n/workflows/README.md).
  const response = await fetch(`${n8nBaseUrl()}/webhook/warmhawk/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      leadId,
      mailboxId,
      campaignId: lead.campaignId,
      email: lead.email,
    }),
  });

  if (!response.ok) {
    throw new Error(`n8n dispatch webhook responded with ${response.status}`);
  }
}

export async function processDailyResetJob(): Promise<void> {
  await prisma.mailbox.updateMany({ data: { sentToday: 0 } });
}

/** BullMQ Worker processor function — dispatches to the right handler based on job name. */
export async function processJob(job: Job): Promise<void> {
  if (job.name === 'daily-reset') {
    await processDailyResetJob();
    return;
  }
  await processDispatchJob(job.data as DispatchJobData);
}
