/**
 * IMAP client factory. OAuth-connected mailboxes (Google or Microsoft) authenticate via XOAUTH2
 * using an access token from mintMailboxAccessToken; SMTP/IMAP-password mailboxes use the stored (encrypted)
 * password. Both paths decrypt server-side only, in this process, and never write plaintext
 * credentials to a log.
 */
import { ImapFlow } from 'imapflow';
import { prisma } from '@warmhawk/db';
import { decrypt, loadEncryptionKey } from './encryption';
import { mintMailboxAccessToken } from './mailboxAccessToken';
import { recordConnectionFailure } from './mailboxConnectionHealth';

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
}

export async function openImapClient(mailboxId: string): Promise<ImapFlow> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw new Error('Mailbox not found');
  if (!mailbox.imapHost || !mailbox.imapPort || !mailbox.authUsername) {
    throw new Error('Mailbox is missing IMAP connection details');
  }

  const key = encryptionKey();

  let auth: { user: string; accessToken?: string; pass?: string } | null = null;

  if (mailbox.oauthRefreshTokenEncrypted) {
    let accessToken: string;
    try {
      accessToken = await mintMailboxAccessToken(
        { ...mailbox, oauthRefreshTokenEncrypted: mailbox.oauthRefreshTokenEncrypted },
        'imap',
      );
    } catch (err) {
      await recordConnectionFailure(mailbox.id, err);
      throw err;
    }
    auth = { user: mailbox.authUsername, accessToken };
  } else if (mailbox.authPasswordEncrypted) {
    auth = { user: mailbox.authUsername, pass: decrypt(mailbox.authPasswordEncrypted, key) };
  }

  if (!auth) {
    throw new Error('Mailbox is missing IMAP credentials (no OAuth token or password on file)');
  }

  const client = new ImapFlow({
    host: mailbox.imapHost,
    port: mailbox.imapPort,
    secure: mailbox.imapPort !== 143,
    auth,
    logger: false,
  });

  try {
    await client.connect();
  } catch (err) {
    // Only an authentication refusal is recorded; a network hiccup is not a reconnect.
    await recordConnectionFailure(mailbox.id, err);
    throw err;
  }
  return client;
}

export const SPAM_FOLDER_CANDIDATES = ['Spam', 'Junk', 'Junk Email', '[Gmail]/Spam'];

export async function listSpamFolders(client: ImapFlow): Promise<string[]> {
  const mailboxes = await client.list();
  const found: string[] = [];
  for (const mb of mailboxes) {
    const isSpamByFlag = mb.specialUse === '\\Junk';
    const isSpamByName = SPAM_FOLDER_CANDIDATES.some(
      (name) => name.toLowerCase() === mb.path.toLowerCase(),
    );
    if (isSpamByFlag || isSpamByName) {
      found.push(mb.path);
    }
  }
  return found;
}

export function encodeMessageId(folder: string, uid: number): string {
  return `${folder}::${uid}`;
}

export function decodeMessageId(messageId: string): { folder: string; uid: number } {
  const separatorIndex = messageId.lastIndexOf('::');
  if (separatorIndex === -1) throw new Error('Malformed messageId');
  const folder = messageId.slice(0, separatorIndex);
  const uid = Number(messageId.slice(separatorIndex + 2));
  if (!folder || !Number.isFinite(uid)) throw new Error('Malformed messageId');
  return { folder, uid };
}
