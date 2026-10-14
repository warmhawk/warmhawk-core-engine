/**
 * A mailbox's daily limit over a rolling 24 hours (10-14-26), counted from `execution_logs`,
 * instead of a `sentToday` counter zeroed at midnight UTC — which, for an install outside UTC,
 * reset mid-afternoon or mid-window and let a second day's batch out the same local day.
 * `Mailbox.sentToday` is still kept, now as this same rolling count, for the dashboard.
 */
import { DAY_MS, prisma, type ExecutionStatus } from '@warmhawk/db';

/** Every send that left the mailbox. A send's log starts SENT and may later move on. */
export const COUNTED_SEND_STATUSES: ExecutionStatus[] = ['SENT', 'OPENED', 'REPLIED', 'BOUNCED'];

/** Each mailbox's send times (ms) in the 24 hours before `now`, oldest first. */
export async function recentSendTimes(
  mailboxIds: string[],
  now: Date,
): Promise<Map<string, number[]>> {
  const byMailbox = new Map<string, number[]>();
  if (mailboxIds.length === 0) return byMailbox;
  const rows = await prisma.executionLog.findMany({
    where: {
      mailboxId: { in: mailboxIds },
      status: { in: COUNTED_SEND_STATUSES },
      createdAt: { gt: new Date(now.getTime() - DAY_MS) },
    },
    select: { mailboxId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const row of rows) {
    if (!row.mailboxId) continue;
    byMailbox.set(row.mailboxId, [
      ...(byMailbox.get(row.mailboxId) ?? []),
      row.createdAt.getTime(),
    ]);
  }
  return byMailbox;
}

/** How many sends one mailbox made in the 24 hours before `now`. */
export function recentSendCount(mailboxId: string, now: Date): Promise<number> {
  return prisma.executionLog.count({
    where: {
      mailboxId,
      status: { in: COUNTED_SEND_STATUSES },
      createdAt: { gt: new Date(now.getTime() - DAY_MS) },
    },
  });
}

/** Sets every mailbox's `sentToday` to its rolling 24-hour count. */
export async function syncSentToday(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "mailboxes" m
    SET "sentToday" = COALESCE((
      SELECT count(*)::int FROM "execution_logs" e
      WHERE e."mailboxId" = m."id"
        AND e."status" IN ('SENT', 'OPENED', 'REPLIED', 'BOUNCED')
        AND e."createdAt" > now() - interval '24 hours'
    ), 0)`;
}
