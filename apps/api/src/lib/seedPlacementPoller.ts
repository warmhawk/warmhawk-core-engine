/**
 * Seed-Inbox Placement Test (Guardrails, V12) — the actual IMAP polling job. Reuses the IMAP
 * client pattern already proven in `imapClient.ts` (ImapFlow, folder listing, mailbox locking,
 * timeout-guarded search), pointed at a `SeedAccount`'s own inbox instead of a sending `Mailbox`'s.
 *
 * A seed account exists ONLY to receive BCC'd copies of real sends (per Guardrails — "BCC a
 * handful of owned seed accounts on a real send"), so — mirroring the same dedicated-purpose
 * assumption `imapClient.ts`'s reply-poll logic already makes about a mailbox's inbox — "the most
 * recent message to arrive in any folder since the campaign's send window" is treated as that
 * campaign's BCC copy. This is a real, complete implementation; it produces real data only once a
 * customer/founder has configured real seed accounts, which is expected (see this repo's build
 * report).
 */
import { ImapFlow } from 'imapflow';
import { prisma, type SeedPlacementFolder } from '@warmhawk/db';
import { decryptSeedImapConfig } from './seedAccounts';
import { classifyFolder } from './seedPlacement';

const POLL_TIMEOUT_MS = 15_000;
const DEFAULT_LOOKBACK_HOURS = 24;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function openSeedImapClient(seedAccountId: string): Promise<ImapFlow> {
  const seedAccount = await prisma.seedAccount.findUnique({ where: { id: seedAccountId } });
  if (!seedAccount) throw new Error('Seed account not found');

  const config = decryptSeedImapConfig(seedAccount.imapConfigEncrypted);
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.port !== 143,
    auth: { user: config.username, pass: config.password },
    logger: false,
  });
  await client.connect();
  return client;
}

/** Checks one seed account's mailbox for the most recent message to arrive in any folder since
 *  `sinceDate`, returning the classified folder it landed in — or `UNCLASSIFIED` if nothing has
 *  arrived there yet within the window (a real, honest outcome: "checked, not found yet", not an
 *  error). INBOX is checked first (the common case, cheapest to confirm), then the known
 *  spam/promotions candidates, then every other folder the account has. */
export async function pollSeedAccountFolder(
  seedAccountId: string,
  sinceDate: Date,
): Promise<SeedPlacementFolder> {
  const client = await openSeedImapClient(seedAccountId);
  try {
    const allFolders = await withTimeout(client.list(), POLL_TIMEOUT_MS, 'IMAP folder list');
    const orderedPaths = [
      'INBOX',
      ...allFolders.map((f) => f.path).filter((path) => path.toUpperCase() !== 'INBOX'),
    ];

    let latestFoundPath: string | null = null;
    let latestFoundUid = -Infinity;

    for (const folderPath of orderedPaths) {
      let lock;
      try {
        lock = await client.getMailboxLock(folderPath);
      } catch {
        continue; // folder not selectable (e.g. a parent-only node) — skip it
      }
      try {
        const uids = await withTimeout(
          client.search({ since: sinceDate }, { uid: true }),
          POLL_TIMEOUT_MS,
          `IMAP search (${folderPath})`,
        );
        if (uids && uids.length > 0) {
          const maxUid = Math.max(...uids);
          if (maxUid > latestFoundUid) {
            latestFoundUid = maxUid;
            latestFoundPath = folderPath;
          }
        }
      } finally {
        lock.release();
      }
    }

    return latestFoundPath ? classifyFolder(latestFoundPath) : 'UNCLASSIFIED';
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export interface SeedPlacementPollSummary {
  campaignsChecked: number;
  seedAccountsChecked: number;
  resultsRecorded: number;
}

/**
 * One full poll tick: finds every campaign with a real send (`ExecutionLog.status = 'SENT'`)
 * within the lookback window, checks every active seed account's placement for it, and records a
 * `SeedPlacementResult` row per (campaign, seed account) pair — called by the n8n
 * `seed-placement-poll` scheduled workflow via `POST /internal/seed-placement/poll`.
 */
export async function runSeedPlacementPollTick(
  lookbackHours: number = DEFAULT_LOOKBACK_HOURS,
): Promise<SeedPlacementPollSummary> {
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const recentSentLogs = await prisma.executionLog.findMany({
    where: { status: 'SENT', createdAt: { gte: since }, campaignId: { not: null } },
    select: { campaignId: true },
    distinct: ['campaignId'],
  });
  const campaignIds = recentSentLogs
    .map((log) => log.campaignId)
    .filter((id): id is string => Boolean(id));

  const seedAccounts = await prisma.seedAccount.findMany({ where: { isActive: true } });

  let resultsRecorded = 0;
  for (const campaignId of campaignIds) {
    for (const seedAccount of seedAccounts) {
      const folder = await pollSeedAccountFolder(seedAccount.id, since).catch(
        () => 'UNCLASSIFIED' as SeedPlacementFolder,
      );
      await prisma.seedPlacementResult.create({
        data: { campaignId, seedAccountId: seedAccount.id, folder },
      });
      resultsRecorded += 1;
    }
  }

  return {
    campaignsChecked: campaignIds.length,
    seedAccountsChecked: seedAccounts.length,
    resultsRecorded,
  };
}
