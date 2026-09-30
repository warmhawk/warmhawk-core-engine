/**
 * Warmup engine — finds a warmup email on the recipient side over IMAP and reports where it
 * landed. Looks in INBOX and the recipient's spam folders (`listSpamFolders`: the `\Junk`
 * special-use flag plus the common folder names), matching by Message-ID first. If the provider
 * rewrote the Message-ID, it falls back to sender + subject and picks the copy whose date is
 * closest to the send.
 *
 * Found in spam -> "rescue": mark read, star, move back to INBOX. Found in inbox -> mark read.
 * Those are the ordinary things a person does with mail they wanted, which is the engagement
 * signal warmup is meant to create — on the customer's own mailboxes only. Then the email is
 * filed under WARMUP_FOLDER (a label in Gmail), so warmup traffic doesn't sit in the inbox.
 */
import type { ImapFlow } from 'imapflow';
import { openImapClient, listSpamFolders } from '../imapClient';
import { openSeedImapClient, subjectSha256 } from '../seedAccounts';

const IMAP_TIMEOUT_MS = 20_000;
/** Where checked warmup emails are filed; created on first use. A label in Gmail. */
export const WARMUP_FOLDER = 'WarmHawk warmup';
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

/** What a delivery-failure report (RFC 3464 DSN) says about one failed recipient. */
export interface BounceReport {
  /** Enhanced status code, e.g. `5.7.708`. */
  status: string | null;
  /** The remote server's reply, e.g. `550 5.7.708 Access denied, traffic not accepted ...`. */
  diagnostic: string | null;
}

export interface InboxReader {
  find(target: WarmupTarget): Promise<FoundMessage | null>;
  /** Found in INBOX: mark it read. */
  markRead(found: FoundMessage): Promise<void>;
  /** Found in spam: mark read, star, move to INBOX. Returns the INBOX copy when the server
   *  reports its new UID (UIDPLUS). */
  rescue(found: FoundMessage): Promise<FoundMessage | undefined>;
  /** Out of the inbox into WARMUP_FOLDER, once its placement is recorded. */
  fileAway?(found: FoundMessage): Promise<void>;
  /** Gmail only: true when the copy found in INBOX sits under the Promotions tab. Gmail keeps
   *  tabs as categories inside INBOX, not as IMAP folders, so `find` alone reports them as INBOX. */
  inPromotions?(found: FoundMessage): Promise<boolean>;
  /** Sender side: the delivery-failure report that came back for `messageId`, if any. */
  findBounce?(messageId: string): Promise<BounceReport | null>;
  close(): Promise<void>;
}

/** A DSN carries the original message, so a large one is cut off; the status lines come first. */
const BOUNCE_MAX_BYTES = 256 * 1024;

/**
 * Pure: reads a raw message and returns its failure report, or null when it isn't a DSN (a person's
 * reply threads the same way) or it only reports a delay. Exchange Online and Gmail both send
 * `multipart/report; report-type=delivery-status` with `In-Reply-To` set to the original
 * Message-ID, which is how `findBounce` finds it.
 */
export function parseBounceReport(source: string): BounceReport | null {
  const headerEnd = source.search(/\r?\n\r?\n/);
  const headers = (headerEnd === -1 ? source : source.slice(0, headerEnd)).replace(
    /\r?\n[ \t]+/g,
    ' ',
  );
  if (!/^content-type:\s*multipart\/report\b[^\n]*report-type="?delivery-status/im.test(headers)) {
    return null;
  }
  const body = source.replace(/\r?\n[ \t]+/g, ' ');
  const actions = [...body.matchAll(/^Action:\s*(\w+)/gim)].map((m) => m[1].toLowerCase());
  if (actions.length > 0 && !actions.includes('failed')) return null;
  const status = body.match(/^Status:\s*(\d\.\d{1,3}\.\d{1,3})/im)?.[1] ?? null;
  const diagnostic =
    body.match(/^Diagnostic-Code:\s*[^;\r\n]*;\s*([^\r\n]+)/im)?.[1]?.trim() ?? null;
  return { status, diagnostic };
}

/** Exchange Online's outbound blocks that only Microsoft support can lift (5.7.705 tenant over
 *  threshold, 5.7.708 low-reputation sending IP — most often a new Microsoft 365 organization). */
const MICROSOFT_OUTBOUND_BLOCK = /^5\.7\.70[58]$/;

/** The line the send log and the Warmup page show for a bounced warmup email. */
export function bounceReasonText(report: BounceReport): string {
  if (report.status && MICROSOFT_OUTBOUND_BLOCK.test(report.status)) {
    return (
      `Microsoft 365 blocked this email before it left your organization (${report.status}). ` +
      'This is common for new Microsoft 365 organizations. Your Microsoft 365 admin can ask ' +
      'Microsoft support to lift the block.'
    );
  }
  const code = report.status ? ` (${report.status})` : '';
  const detail = report.diagnostic ? `: ${report.diagnostic}` : '.';
  return `The mail server returned this email${code}${detail}`.slice(0, 500);
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
  private warmupFolder: string | null = null;

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

  async rescue(found: FoundMessage): Promise<FoundMessage | undefined> {
    const lock = await this.client.getMailboxLock(found.folder);
    try {
      await this.client.messageFlagsAdd({ uid: String(found.uid) }, ['\\Seen', '\\Flagged'], {
        uid: true,
      });
      const moved = await this.client.messageMove({ uid: String(found.uid) }, 'INBOX', {
        uid: true,
      });
      const uid = moved ? moved.uidMap?.get(found.uid) : undefined;
      return uid ? { folder: 'INBOX', uid, inSpam: false } : undefined;
    } finally {
      lock.release();
    }
  }

  async inPromotions(found: FoundMessage): Promise<boolean> {
    if (found.inSpam || !this.client.capabilities.has('X-GM-EXT-1')) return false;
    const lock = await this.client.getMailboxLock(found.folder);
    try {
      const uids = await withTimeout(
        this.client.search({ uid: String(found.uid), gmraw: 'category:promotions' }, { uid: true }),
        'IMAP search',
      );
      return !!uids && uids.length > 0;
    } finally {
      lock.release();
    }
  }

  async fileAway(found: FoundMessage): Promise<void> {
    const target = await this.ensureWarmupFolder();
    const lock = await this.client.getMailboxLock(found.folder);
    try {
      await withTimeout(
        this.client.messageMove({ uid: String(found.uid) }, target, { uid: true }),
        'IMAP move',
      );
    } finally {
      lock.release();
    }
  }

  private async ensureWarmupFolder(): Promise<string> {
    if (!this.warmupFolder) {
      const all = await withTimeout(this.client.list(), 'IMAP folder list');
      const existing = all.find((mb) => mb.path.toLowerCase() === WARMUP_FOLDER.toLowerCase());
      this.warmupFolder = existing
        ? existing.path
        : (await withTimeout(this.client.mailboxCreate(WARMUP_FOLDER), 'IMAP create folder')).path;
    }
    return this.warmupFolder;
  }

  async findBounce(messageId: string): Promise<BounceReport | null> {
    const folders = await this.searchFolders();
    for (const f of folders) {
      const lock = await this.client.getMailboxLock(f.path);
      try {
        const uids = await withTimeout(
          this.client.search(
            {
              or: [{ header: { 'in-reply-to': messageId } }, { header: { references: messageId } }],
            },
            { uid: true },
          ),
          'IMAP search',
        );
        for (const uid of [...(uids || [])].sort((a, b) => b - a).slice(0, 5)) {
          const msg = await withTimeout(
            this.client.fetchOne(
              String(uid),
              { source: { maxLength: BOUNCE_MAX_BYTES } },
              { uid: true },
            ),
            'IMAP fetch',
          );
          const report = msg && msg.source ? parseBounceReport(msg.source.toString('utf8')) : null;
          if (report) return report;
        }
      } finally {
        lock.release();
      }
    }
    return null;
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
