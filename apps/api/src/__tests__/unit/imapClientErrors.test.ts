/**
 * An IMAP connection that resets after connect() settled reports it as an 'error' event. An
 * EventEmitter with no 'error' listener throws that event, which exited the whole API process live
 * (2026-10-15, during n8n's reply poll). Both client factories must attach a listener.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => ({
  prisma: {
    mailbox: { findUnique: vi.fn() },
    seedAccount: { findUnique: vi.fn() },
  },
}));
vi.mock('@warmhawk/db', () => db);

vi.mock('imapflow', () => ({
  ImapFlow: class extends EventEmitter {
    connect = vi.fn(async () => undefined);
  },
}));

import { openImapClient } from '../../lib/imapClient';
import { encryptSeedImapConfig, openSeedImapClient } from '../../lib/seedAccounts';
import { encrypt, loadEncryptionKey } from '../../lib/encryption';

const TEST_KEY = Buffer.from('a'.repeat(32)).toString('base64');
const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

describe('IMAP clients survive a connection reset', () => {
  const originalKey = process.env.MAILBOX_CREDENTIAL_KEY;

  beforeEach(() => {
    process.env.MAILBOX_CREDENTIAL_KEY = TEST_KEY;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.MAILBOX_CREDENTIAL_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('openImapClient: an error event after connect is logged, not thrown', async () => {
    db.prisma.mailbox.findUnique.mockResolvedValue({
      id: 'mb-1',
      imapHost: 'imap.example.com',
      imapPort: 993,
      authUsername: 'a@example.com',
      authPasswordEncrypted: encrypt('pw', loadEncryptionKey(TEST_KEY)),
      oauthRefreshTokenEncrypted: null,
    });
    const client = await openImapClient('mb-1');
    expect(() => client.emit('error', reset())).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith('[imap] mailbox mb-1: read ECONNRESET');
  });

  it('openSeedImapClient: an error event after connect is logged, not thrown', async () => {
    db.prisma.seedAccount.findUnique.mockResolvedValue({
      id: 'seed-1',
      imapConfigEncrypted: encryptSeedImapConfig({
        host: 'imap.example.com',
        port: 993,
        username: 'seed@example.com',
        password: 'pw',
      }),
    });
    const client = await openSeedImapClient('seed-1');
    expect(() => client.emit('error', reset())).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith('[imap] seed seed-1: read ECONNRESET');
  });
});
