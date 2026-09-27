/**
 * Warmup engine — unit tests for partner choice (`lib/warmup/partners.ts`) and the fallback
 * date match (`lib/warmup/placement.ts`'s `pickClosestByDate`).
 */
import { describe, it, expect } from 'vitest';
import {
  choosePartner,
  mailboxCanWarm,
  partnersFor,
  type WarmupPartner,
} from '../../lib/warmup/partners';
import { pickClosestByDate } from '../../lib/warmup/placement';

const p = (email: string, kind: 'mailbox' | 'seed' = 'mailbox'): WarmupPartner => ({
  kind,
  id: email,
  email,
  domain: email.split('@')[1],
});

describe('mailboxCanWarm', () => {
  const ok = {
    status: 'WARMUP',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    authUsername: 'a@x.com',
    oauthRefreshTokenEncrypted: 'enc',
    authPasswordEncrypted: null,
  };
  it('needs IMAP details and a credential, and not PAUSED', () => {
    expect(mailboxCanWarm(ok)).toBe(true);
    expect(
      mailboxCanWarm({ ...ok, oauthRefreshTokenEncrypted: null, authPasswordEncrypted: 'enc' }),
    ).toBe(true);
    expect(mailboxCanWarm({ ...ok, oauthRefreshTokenEncrypted: null })).toBe(false);
    expect(mailboxCanWarm({ ...ok, imapHost: null })).toBe(false);
    expect(mailboxCanWarm({ ...ok, status: 'PAUSED' })).toBe(false);
  });
});

describe('partnersFor', () => {
  it('excludes the sender itself, case-insensitively', () => {
    const pool = [p('a@x.com'), p('b@y.com')];
    expect(partnersFor('A@X.com', pool).map((x) => x.email)).toEqual(['b@y.com']);
  });
});

describe('choosePartner', () => {
  it('returns null with no partners', () => {
    expect(
      choosePartner({ senderEmail: 'a@x.com', partners: [], recentCounts: new Map() }),
    ).toBeNull();
  });
  it('prefers a partner on a different domain', () => {
    const chosen = choosePartner({
      senderEmail: 'a@x.com',
      partners: [p('b@x.com'), p('c@y.com')],
      recentCounts: new Map(),
    });
    expect(chosen?.email).toBe('c@y.com');
  });
  it('falls back to a same-domain partner when that is all there is', () => {
    const chosen = choosePartner({
      senderEmail: 'a@x.com',
      partners: [p('b@x.com')],
      recentCounts: new Map(),
    });
    expect(chosen?.email).toBe('b@x.com');
  });
  it('spreads sends to the least-used partner', () => {
    const chosen = choosePartner({
      senderEmail: 'a@x.com',
      partners: [p('b@y.com'), p('seed@gmail.com', 'seed')],
      recentCounts: new Map([
        ['b@y.com', 3],
        ['seed@gmail.com', 1],
      ]),
    });
    expect(chosen?.email).toBe('seed@gmail.com');
  });
});

describe('pickClosestByDate', () => {
  const sentAt = new Date('2026-09-26T12:00:00Z');
  const at = (mins: number) => new Date(sentAt.getTime() + mins * 60_000);
  it('picks the copy closest to the send time', () => {
    expect(
      pickClosestByDate(
        [
          { uid: 1, date: at(-240) },
          { uid: 2, date: at(1) },
          { uid: 3, date: at(30) },
        ],
        sentAt,
      ),
    ).toBe(2);
  });
  it('ignores copies outside the window or without a date', () => {
    expect(
      pickClosestByDate(
        [
          { uid: 1, date: at(-10) },
          { uid: 2, date: at(200) },
          { uid: 3, date: null },
        ],
        sentAt,
      ),
    ).toBeNull();
  });
});
