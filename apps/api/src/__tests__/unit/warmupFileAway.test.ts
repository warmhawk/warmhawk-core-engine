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

describe('ImapInboxReader.inPromotions', () => {
  function gmail(opts: { gmail: boolean; promoUids: number[]; fail?: boolean }) {
    const searches: unknown[] = [];
    const client = {
      capabilities: new Map(opts.gmail ? [['X-GM-EXT-1', true]] : []),
      getMailboxLock: async () => ({ release: () => undefined }),
      search: async (query: { uid: string; gmraw: string }) => {
        searches.push(query);
        if (opts.fail) throw new Error('NO search failed');
        return opts.promoUids.includes(Number(query.uid)) ? [Number(query.uid)] : [];
      },
    };
    return { client: client as unknown as ImapFlow, searches };
  }

  it('is true for a Gmail INBOX copy filed under the Promotions tab', async () => {
    const { client, searches } = gmail({ gmail: true, promoUids: [9] });
    const reader = new ImapInboxReader(client);
    expect(await reader.inPromotions({ folder: 'INBOX', uid: 9, inSpam: false })).toBe(true);
    expect(searches).toEqual([{ uid: '9', gmraw: 'category:promotions' }]);
  });

  it('is false for a Gmail INBOX copy in the Primary tab', async () => {
    const { client } = gmail({ gmail: true, promoUids: [] });
    expect(
      await new ImapInboxReader(client).inPromotions({ folder: 'INBOX', uid: 4, inSpam: false }),
    ).toBe(false);
  });

  it('never asks a server without Gmail extensions, or about a spam copy', async () => {
    const plain = gmail({ gmail: false, promoUids: [1] });
    expect(
      await new ImapInboxReader(plain.client).inPromotions({
        folder: 'INBOX',
        uid: 1,
        inSpam: false,
      }),
    ).toBe(false);
    const spam = gmail({ gmail: true, promoUids: [1] });
    expect(
      await new ImapInboxReader(spam.client).inPromotions({
        folder: '[Gmail]/Spam',
        uid: 1,
        inSpam: true,
      }),
    ).toBe(false);
    expect(plain.searches).toEqual([]);
    expect(spam.searches).toEqual([]);
  });

  it('passes a search error up, for the engine to treat as inbox', async () => {
    const { client } = gmail({ gmail: true, promoUids: [], fail: true });
    await expect(
      new ImapInboxReader(client).inPromotions({ folder: 'INBOX', uid: 2, inSpam: false }),
    ).rejects.toThrow(/search failed/);
  });
});
