/**
 * Warmup engine — finds a warmup email on the recipient side over IMAP and reports where it
 * landed. Looks in INBOX and the recipient's spam folders (`listSpamFolders`: the `\Junk`
 * special-use flag plus the common folder names), matching by Message-ID first. If the provider
 * rewrote the Message-ID, it falls back to sender + subject and picks the copy whose date is
 * closest to the send.
 *
 * Found in spam -> "rescue": mark read, star, move back to INBOX. Found in inbox -> mark read.
 * Those are the ordinary things a person does with mail they wanted, which is the engagement
 * signal warmup is meant to create — on the customer's own mailboxes only.
 */
import type { ImapFlow } from 'imapflow';
import { openImapClient, listSpamFolders } from '../imapClient';
import { openSeedImapClient, subjectSha256 } from '../seedAccounts';

const IMAP_TIMEOUT_MS = 20_000;
/** Fallback-match window around the send time. */
const FALLBACK_BEFORE_MS = 5 * 60 * 1000;
const FALLBACK_AFTER_MS = 3 * 60 * 60 * 1000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${IMAP_TIMEOUT_MS}ms`)),
        IMAP_TIMEOUT_MS,
      ),
    ),
  ]);
}

export interface WarmupTarget {
  messageId: string | null;
  /** Warmup emails carry their subject; a sampled campaign copy carries only its hash. */
  subject: string | null;
  subjectSha256?: string | null;
  fromEmail: string;
  sentAt: Date;
}

export interface FoundMessage {
  folder: string;
  uid: number;
  inSpam: boolean;
}

export interface InboxReader {
  find(target: WarmupTarget): Promise<FoundMessage | null>;
  /** Found in INBOX: mark it read. */
  markRead(found: FoundMessage): Promise<void>;
  /** Found in spam: mark read, star, move to INBOX. */
  rescue(found: FoundMessage): Promise<void>;
  close(): Promise<void>;
}

export type PartnerRef = { kind: 'mailbox' | 'seed'; id: string };

/** Pure: pick the fallback match whose date is closest to the send, inside the window. */
export function pickClosestByDate(
  candidates: Array<{ uid: number; date: Date | null }>,
  sentAt: Date,
): number | null {
  let best: { uid: number; delta: number } | null = null;
  for (const c of candidates) {
    if (!c.date) continue;
    const delta = c.date.getTime() - sentAt.getTime();
    if (delta < -FALLBACK_BEFORE_MS || delta > FALLBACK_AFTER_MS) continue;
    const abs = Math.abs(delta);
    if (!best || abs < best.delta) best = { uid: c.uid, delta: abs };
  }
  return best ? best.uid : null;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export class ImapInboxReader implements InboxReader {
  private folders: Array<{ path: string; inSpam: boolean }> | null = null;

  constructor(private readonly client: ImapFlow) {}

  private async searchFolders(): Promise<Array<{ path: string; inSpam: boolean }>> {
    if (!this.folders) {
      const spam = await withTimeout(listSpamFolders(this.client), 'IMAP folder list');
      this.folders = [
        { path: 'INBOX', inSpam: false },
        ...spam.map((path) => ({ path, inSpam: true })),
      ];
    }
    return this.folders;
  }

  async find(target: WarmupTarget): Promise<FoundMessage | null> {
    const folders = await this.searchFolders();

    if (target.messageId) {
      for (const f of folders) {
        const lock = await this.client.getMailboxLock(f.path);
        try {
          const uids = await withTimeout(
            this.client.search({ header: { 'message-id': target.messageId } }, { uid: true }),
            'IMAP search',
          );
          if (uids && uids.length > 0)
            return { folder: f.path, uid: Math.max(...uids), inSpam: f.inSpam };
        } finally {
          lock.release();
        }
      }
    }

    if (!target.subject && !target.subjectSha256) return null;

    for (const f of folders) {
      const lock = await this.client.getMailboxLock(f.path);
      try {
        const uids = await withTimeout(
          this.client.search(
            {
              from: target.fromEmail,
              ...(target.subject ? { subject: target.subject } : {}),
              since: startOfUtcDay(target.sentAt),
            },
            { uid: true },
          ),
          'IMAP search',
        );
        if (!uids || uids.length === 0) continue;
        const candidates: Array<{ uid: number; date: Date | null }> = [];
        for await (const msg of this.client.fetch(
          uids.join(','),
          { envelope: true, internalDate: true },
          { uid: true },
        )) {
          if (
            !target.subject &&
            subjectSha256(msg.envelope?.subject ?? '') !== target.subjectSha256
          ) {
            continue;
          }
          const internal = msg.internalDate ? new Date(msg.internalDate) : null;
          candidates.push({ uid: msg.uid, date: msg.envelope?.date ?? internal });
        }
        const uid = pickClosestByDate(candidates, target.sentAt);
        if (uid !== null) return { folder: f.path, uid, inSpam: f.inSpam };
      } finally {
        lock.release();
      }
    }
    return null;
  }

  async markRead(found: FoundMessage): Promise<void> {
    const lock = await this.client.getMailboxLock(found.folder);
    try {
      await this.client.messageFlagsAdd({ uid: String(found.uid) }, ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  }

  async rescue(found: FoundMessage): Promise<void> {
    const lock = await this.client.getMailboxLock(found.folder);
    try {
      await this.client.messageFlagsAdd({ uid: String(found.uid) }, ['\\Seen', '\\Flagged'], {
        uid: true,
      });
      await this.client.messageMove({ uid: String(found.uid) }, 'INBOX', { uid: true });
    } finally {
      lock.release();
    }
  }

  async close(): Promise<void> {
    await this.client.logout().catch(() => this.client.close());
  }
}

export async function openInboxReader(partner: PartnerRef): Promise<InboxReader> {
  const client =
    partner.kind === 'mailbox'
      ? await openImapClient(partner.id)
      : await openSeedImapClient(partner.id);
  return new ImapInboxReader(client);
}
