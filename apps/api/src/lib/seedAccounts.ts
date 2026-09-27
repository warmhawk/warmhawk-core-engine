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
import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
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

/** Share of campaign sends that also BCC the active seed inboxes. Sampling keeps each seed's
 *  inbound volume near what a person receives (a 300/day sender puts ~15/day in each seed) —
 *  BCC'ing every send would flood the seed and skew its own filtering. `SEED_BCC_SAMPLE_RATE`
 *  (0–1) overrides it. */
export const DEFAULT_SEED_BCC_SAMPLE_RATE = 0.05;

export function seedBccSampleRate(): number {
  const raw = process.env.SEED_BCC_SAMPLE_RATE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SEED_BCC_SAMPLE_RATE;
  const rate = Number(raw);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : DEFAULT_SEED_BCC_SAMPLE_RATE;
}

/** Pure: whether this one send is in the sample. */
export function isSeedBccSample(rng: () => number, rate: number = seedBccSampleRate()): boolean {
  return rate > 0 && rng() < rate;
}

/** SHA-256 hex of a subject line — the fallback match key, so the subject itself isn't stored. */
export function subjectSha256(subject: string): string {
  return createHash('sha256').update(subject.trim()).digest('hex');
}

/** The send-pipeline BCC hook (`lib/mailSender.ts`) calls this on every campaign send: the active
 *  seed inboxes when this send is in the sample, else none. Also none when no seed accounts are
 *  configured yet. */
export async function pickSeedBccSample(
  rng: () => number = Math.random,
): Promise<Array<{ id: string; emailAddress: string }>> {
  if (!isSeedBccSample(rng)) return [];
  return prisma.seedAccount.findMany({
    where: { isActive: true },
    select: { id: true, emailAddress: true },
  });
}

export async function openSeedImapClient(seedAccountId: string): Promise<ImapFlow> {
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
