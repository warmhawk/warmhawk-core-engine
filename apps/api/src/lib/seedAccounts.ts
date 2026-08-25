/**
 * Seed-Inbox Placement Test (Guardrails, V12, option (c) — "placement sampling," the spec's own
 * recommended default for a solo/bootstrap launch). A `SeedAccount` is a founder/customer-owned
 * mailbox used only to RECEIVE a BCC copy of real sends and report which folder it landed in —
 * never a sending mailbox (that's `Mailbox`, a wholly separate model).
 *
 * `imapConfigEncrypted` stores a single AES-256-GCM ciphertext blob (same `encryption.ts`
 * mechanism as `Mailbox.authPasswordEncrypted`) holding serialized JSON:
 * `{ host: string, port: number, username: string, password: string }` — deliberately simpler
 * than `Mailbox`'s OAuth/SMTP/IMAP split, since a seed account only ever needs read-IMAP access.
 */
import { prisma } from '@warmhawk/db';
import { encrypt, decrypt, loadEncryptionKey } from './encryption';

export interface SeedImapConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
}

export function encryptSeedImapConfig(config: SeedImapConfig): string {
  return encrypt(JSON.stringify(config), encryptionKey());
}

export function decryptSeedImapConfig(imapConfigEncrypted: string): SeedImapConfig {
  const parsed = JSON.parse(decrypt(imapConfigEncrypted, encryptionKey())) as SeedImapConfig;
  if (!parsed.host || !parsed.port || !parsed.username || !parsed.password) {
    throw new Error('Malformed seed account IMAP config');
  }
  return parsed;
}

/** The send-pipeline BCC hook (`lib/mailSender.ts`) reads this on every campaign send — returns
 *  an empty array (graceful no-op) when no seed accounts are configured yet, per the spec:
 *  "this is customer/founder-configured, not something requiring live seed accounts to exist in
 *  THIS build." */
export async function getActiveSeedBccEmails(): Promise<string[]> {
  const seedAccounts = await prisma.seedAccount.findMany({
    where: { isActive: true },
    select: { emailAddress: true },
  });
  return seedAccounts.map((s) => s.emailAddress);
}
