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

export type SuppressionSource = 'manual' | 'reply_opt_out' | 'unsubscribe_link' | 'import';

/** Rows per transaction for a bulk block — keeps one `IN (…)` list and one transaction small. */
const BULK_CHUNK = 1000;

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
      // Clearing `nextStepAt` ends any follow-up sequence too.
      data: { status: 'SUPPRESSED', nextRetryAt: null, nextStepAt: null },
    }),
  ]);
}

/** `suppressEmail` for a whole do-not-contact list (Settings → Compliance import). Addresses must
 *  already be normalized (trimmed, lowercased) and valid. The same two writes per chunk, one
 *  transaction each. Returns how many were new to the list. */
export async function suppressEmails(
  emails: string[],
  entry: { source: SuppressionSource; reason: string },
): Promise<{ added: number }> {
  let added = 0;
  for (let i = 0; i < emails.length; i += BULK_CHUNK) {
    const chunk = emails.slice(i, i + BULK_CHUNK);
    const [created] = await prisma.$transaction([
      // Already-listed addresses keep the entry they have, same as `suppressEmail`'s `update: {}`.
      prisma.suppressionEntry.createMany({
        data: chunk.map((email) => ({ email, reason: entry.reason, source: entry.source })),
        skipDuplicates: true,
      }),
      prisma.lead.updateMany({
        where: { email: { in: chunk }, status: { not: 'SUPPRESSED' } },
        data: { status: 'SUPPRESSED', nextRetryAt: null, nextStepAt: null },
      }),
    ]);
    added += created.count;
  }
  return { added };
}

/** Takes an address off the list. Deliberately leaves its lead rows SUPPRESSED: their step timing
 *  is gone, and an unblock must never restart a sequence nobody expected. The address can be
 *  imported into a campaign again. Returns false when it wasn't on the list. */
export async function unsuppressEmail(email: string): Promise<boolean> {
  const { count } = await prisma.suppressionEntry.deleteMany({ where: { email } });
  return count > 0;
}
