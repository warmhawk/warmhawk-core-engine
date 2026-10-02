/**
 * The one way an address gets suppressed (Guardrails — "no code path anywhere may re-add or
 * bypass a suppressed email").
 *
 * A lead is one row per campaign, so the same person can sit in several. Opting out of one email
 * is opting out of the sender, not of a campaign: this adds the address to the suppression list
 * and marks every lead row carrying it, in one transaction, so the list and the rows never
 * disagree.
 */
import { prisma } from '@warmhawk/db';

export type SuppressionSource = 'manual' | 'reply_opt_out' | 'unsubscribe_link';

export async function suppressEmail(
  email: string,
  entry: { source: SuppressionSource; reason: string },
): Promise<void> {
  await prisma.$transaction([
    prisma.suppressionEntry.upsert({
      where: { email },
      create: { email, reason: entry.reason, source: entry.source },
      // The first opt-out is the one on record; a later click doesn't rewrite how it happened.
      update: {},
    }),
    prisma.lead.updateMany({
      where: { email, status: { not: 'SUPPRESSED' } },
      data: { status: 'SUPPRESSED', nextRetryAt: null },
    }),
  ]);
}
