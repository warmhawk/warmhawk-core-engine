/**
 * Seed-Inbox Placement Test (Guardrails, V12) — unit test for the IMAP config encrypt/decrypt
 * round trip (`lib/seedAccounts.ts`), same AES-256-GCM mechanism as `Mailbox` credentials
 * (`encryption.test.ts`), applied to a seed account's serialized `{host, port, username,
 * password}` blob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptSeedImapConfig, decryptSeedImapConfig } from '../../lib/seedAccounts';

const TEST_KEY = Buffer.from('a'.repeat(32)).toString('base64');

describe('seed account IMAP config encrypt/decrypt round trip', () => {
  const originalKey = process.env.MAILBOX_CREDENTIAL_KEY;

  beforeEach(() => {
    process.env.MAILBOX_CREDENTIAL_KEY = TEST_KEY;
  });

  afterEach(() => {
    process.env.MAILBOX_CREDENTIAL_KEY = originalKey;
  });

  it('round-trips a full IMAP config', () => {
    const config = {
      host: 'imap.gmail.com',
      port: 993,
      username: 'seed1@example.com',
      password: 'super-secret-app-password',
    };
    const encrypted = encryptSeedImapConfig(config);
    expect(encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(decryptSeedImapConfig(encrypted)).toEqual(config);
  });

  it('throws on a malformed (incomplete) decrypted payload', () => {
    // Encrypt something that decrypts fine but isn't a valid SeedImapConfig shape.
    const encrypted = encryptSeedImapConfig({
      host: '',
      port: 0,
      username: '',
      password: '',
    } as never);
    expect(() => decryptSeedImapConfig(encrypted)).toThrow(/Malformed seed account IMAP config/);
  });
});
