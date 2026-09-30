/**
 * Seed-Inbox Placement Test (Guardrails, V12) — checks where each sampled campaign copy landed.
 *
 * The send path (`mailSender.ts`) BCCs the active seed inboxes on a sample of campaign sends and
 * writes one pending `SeedPlacementResult` per seed copy, carrying the send's Message-ID. This
 * job finds that exact email in the seed inbox — INBOX first, then the spam folders — with the
 * same IMAP reader the warmup engine uses, falling back to sender + subject hash when a provider
 * rewrote the Message-ID. Matching the exact email matters because seed inboxes also receive
 * warmup emails: "whatever arrived last" would report warmup mail as campaign placement.
 *
 * Campaign copies are only looked at, never marked read or moved — this measures placement, it
 * doesn't try to improve it. Runs inside every warmup tick (every 10 minutes) and from
 * `POST /internal/seed-placement/poll`.
 */
import { prisma, type SeedPlacementFolder } from '@warmhawk/db';
import { openInboxReader, type InboxReader, type PartnerRef } from './warmup/placement';
import { CHECK_AFTER_MS, CHECK_GIVE_UP_MS, UNCHECKED_AFTER_MS } from './warmup/policy';

/** Max sampled copies checked per run — keeps one tick well inside n8n's HTTP timeout. */
const CHECK_BATCH = 100;

export interface SeedPlacementDeps {
  now: () => Date;
  openReader: (partner: PartnerRef) => Promise<InboxReader>;
}

export const defaultSeedPlacementDeps: SeedPlacementDeps = {
  now: () => new Date(),
  openReader: openInboxReader,
};

export interface SeedPlacementPollSummary {
  /** Copies given a final folder this run (found, or not found after 2 hours). */
  seedChecked: number;
  /** Copies dropped because their seed inbox couldn't be read for 6 hours — never counted. */
  seedDropped: number;
}

export async function checkSampledPlacements(
  deps: SeedPlacementDeps = defaultSeedPlacementDeps,
): Promise<SeedPlacementPollSummary> {
  const now = deps.now();
  const pending = await prisma.seedPlacementResult.findMany({
    where: {
      checkedAt: null,
      mailboxId: { not: null },
      sentAt: { lte: new Date(now.getTime() - CHECK_AFTER_MS) },
    },
    orderBy: { sentAt: 'asc' },
    take: CHECK_BATCH,
    include: { mailbox: { select: { email: true } } },
  });

  const bySeed = new Map<string, typeof pending>();
  for (const row of pending) {
    const rows = bySeed.get(row.seedAccountId) ?? [];
    rows.push(row);
    bySeed.set(row.seedAccountId, rows);
  }

  let seedChecked = 0;
  let seedDropped = 0;

  for (const [seedAccountId, rows] of bySeed) {
    let reader: InboxReader | null = null;
    try {
      reader = await deps.openReader({ kind: 'seed', id: seedAccountId });
    } catch {
      reader = null;
    }

    try {
      for (const row of rows) {
        const age = now.getTime() - (row.sentAt ?? now).getTime();
        let found;
        try {
          found = reader
            ? await reader.find({
                messageId: row.messageId,
                subject: null,
                subjectSha256: row.subjectSha256,
                fromEmail: row.mailbox?.email ?? '',
                sentAt: row.sentAt ?? now,
              })
            : undefined;
        } catch {
          found = undefined;
        }

        if (found === undefined) {
          // Couldn't read the seed inbox. Not a placement result, so it never counts.
          if (age >= UNCHECKED_AFTER_MS) {
            await prisma.seedPlacementResult.delete({ where: { id: row.id } });
            seedDropped += 1;
          }
          continue;
        }

        let folder: SeedPlacementFolder;
        if (found?.inSpam) folder = 'SPAM';
        else if (found)
          folder = (await reader?.inPromotions?.(found).catch(() => false))
            ? 'PROMOTIONS'
            : 'INBOX';
        else if (age >= CHECK_GIVE_UP_MS) folder = 'UNCLASSIFIED';
        else continue;

        await prisma.seedPlacementResult.update({
          where: { id: row.id },
          data: { folder, checkedAt: now },
        });
        seedChecked += 1;
      }
    } finally {
      if (reader) await reader.close().catch(() => undefined);
    }
  }

  return { seedChecked, seedDropped };
}

/** `POST /internal/seed-placement/poll` entry point, kept for the n8n `seed-placement-poll`
 *  workflow already installed on existing instances. */
export async function runSeedPlacementPollTick(): Promise<SeedPlacementPollSummary> {
  return checkSampledPlacements();
}
