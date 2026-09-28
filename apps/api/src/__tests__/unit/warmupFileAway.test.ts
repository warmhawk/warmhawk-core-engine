/**
 * ImapInboxReader — after a warmup email's placement is recorded it is filed under
 * WARMUP_FOLDER, so warmup traffic doesn't sit in the customer's inbox.
 */
import { describe, it, expect } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { ImapInboxReader, WARMUP_FOLDER } from '../../lib/warmup/placement';

function fakeClient(opts: { folders: string[]; uidMap?: Map<number, number> }) {
  const calls: string[] = [];
  const client = {
    list: async () => {
      calls.push('list');
      return opts.folders.map((path) => ({ path }));
    },
    mailboxCreate: async (path: string) => {
      calls.push(`create ${path}`);
      return { path, created: true };
    },
    getMailboxLock: async (path: string) => {
      calls.push(`lock ${path}`);
      return { release: () => undefined };
    },
    messageFlagsAdd: async () => true,
    messageMove: async (range: { uid: string }, dest: string) => {
      calls.push(`move ${range.uid} -> ${dest}`);
      return { path: 'x', destination: dest, uidMap: opts.uidMap };
    },
  };
  return { client: client as unknown as ImapFlow, calls };
}

describe('ImapInboxReader.fileAway', () => {
  it('creates the warmup folder once, then moves each email into it', async () => {
    const { client, calls } = fakeClient({ folders: ['INBOX', 'Junk'] });
    const reader = new ImapInboxReader(client);
    await reader.fileAway({ folder: 'INBOX', uid: 7, inSpam: false });
    await reader.fileAway({ folder: 'INBOX', uid: 8, inSpam: false });
    expect(calls).toEqual([
      'list',
      `create ${WARMUP_FOLDER}`,
      'lock INBOX',
      `move 7 -> ${WARMUP_FOLDER}`,
      'lock INBOX',
      `move 8 -> ${WARMUP_FOLDER}`,
    ]);
  });

  it('reuses an existing folder whatever its case', async () => {
    const { client, calls } = fakeClient({ folders: ['INBOX', 'warmhawk WARMUP'] });
    await new ImapInboxReader(client).fileAway({ folder: 'INBOX', uid: 3, inSpam: false });
    expect(calls).not.toContain(`create ${WARMUP_FOLDER}`);
    expect(calls).toContain('move 3 -> warmhawk WARMUP');
  });
});

describe('ImapInboxReader.rescue', () => {
  it('returns the INBOX copy when the server reports its new UID', async () => {
    const { client } = fakeClient({ folders: [], uidMap: new Map([[5, 42]]) });
    const inbox = await new ImapInboxReader(client).rescue({
      folder: 'Junk',
      uid: 5,
      inSpam: true,
    });
    expect(inbox).toEqual({ folder: 'INBOX', uid: 42, inSpam: false });
  });

  it('returns nothing when the server does not say where it went', async () => {
    const { client } = fakeClient({ folders: [] });
    const inbox = await new ImapInboxReader(client).rescue({
      folder: 'Junk',
      uid: 5,
      inSpam: true,
    });
    expect(inbox).toBeUndefined();
  });
});
