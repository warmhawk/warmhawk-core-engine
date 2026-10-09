/**
 * Integration test for the warmup engine against a REAL Postgres (docker-compose.test.yml): the
 * full tick (`runWarmupTick` — check, decide, send), the dashboard routes (`/v1/warmup`,
 * `/v1/warmup/:id/messages`, `/v1/warmup/:id/send-now`), the per-mailbox pause
 * (`PATCH /v1/mailboxes/:id { warmupEnabled }`) and the n8n trigger (`POST /internal/warmup/tick`).
 *
 * Mail I/O goes through a small in-memory "mail world" passed in as `WarmupDeps` — every Postgres
 * read and write is real. A second block covers how sends spread across inboxes (one per inbox
 * per tick, no repeated subjects) and Gmail's Promotions tab. Real SMTP/IMAP is covered
 * separately by the GreenMail e2e test (`warmupMail.e2e.integration.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { runWarmupTick, type WarmupDeps } from '../../lib/warmup/engine';
import {
  WARMUP_FOLDER,
  type BounceReport,
  type FoundMessage,
  type InboxReader,
  type PartnerRef,
  type WarmupTarget,
} from '../../lib/warmup/placement';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Folder = 'INBOX' | 'Junk' | typeof WARMUP_FOLDER;

/** In-memory stand-in for SMTP + IMAP: sends land in a folder the test chooses per recipient. */
class MailWorld {
  delivered = new Map<
    string,
    {
      to: string;
      uid: number;
      folder: Folder;
      seen: boolean;
      flagged: boolean;
      promotions: boolean;
    }
  >();
  spamFor = new Set<string>();
  /** Recipients whose (Gmail) inbox sorts warmup mail under the Promotions tab. */
  promotionsFor = new Set<string>();
  /** Recipients whose Promotions lookup fails, the way a Gmail search can time out. */
  promotionsErrorFor = new Set<string>();
  dropFor = new Set<string>();
  brokenReaders = new Set<string>();
  /** Message-ID -> sender email: a delivery-failure report sits in the sender's mailbox. */
  bounces = new Map<string, string>();
  sends: Array<{ from: string; to: string; subject: string }> = [];
  private n = 0;

  constructor(private readonly emailById: Map<string, string>) {}

  private at(owner: string, f: FoundMessage) {
    return [...this.delivered.values()].find(
      (d) => d.to === owner && d.uid === f.uid && d.folder === f.folder,
    );
  }

  deps(clock: { now: Date }): WarmupDeps {
    return {
      now: () => clock.now,
      rng: () => 0.42,
      send: async (input) => {
        const from = this.emailById.get(input.mailboxId) ?? input.mailboxId;
        this.sends.push({ from, to: input.to, subject: input.subject });
        const messageId = `<warm-${++this.n}@fake.test>`;
        if (!this.dropFor.has(input.to)) {
          this.delivered.set(messageId, {
            to: input.to,
            uid: this.n,
            folder: this.spamFor.has(input.to) ? 'Junk' : 'INBOX',
            seen: false,
            flagged: false,
            promotions: this.promotionsFor.has(input.to),
          });
        }
        return { messageId };
      },
      openReader: async (ref: PartnerRef): Promise<InboxReader> => {
        const owner = this.emailById.get(ref.id) ?? '';
        if (this.brokenReaders.has(ref.id)) throw new Error('IMAP login failed');
        return {
          find: async (t: WarmupTarget): Promise<FoundMessage | null> => {
            const d = t.messageId ? this.delivered.get(t.messageId) : undefined;
            if (!d || d.to !== owner) return null;
            return { folder: d.folder, uid: d.uid, inSpam: d.folder === 'Junk' };
          },
          inPromotions: async (f: FoundMessage) => {
            if (this.promotionsErrorFor.has(owner)) throw new Error('IMAP search timed out');
            return !f.inSpam && Boolean(this.at(owner, f)?.promotions);
          },
          markRead: async (f: FoundMessage) => {
            const d = this.at(owner, f);
            if (d) d.seen = true;
          },
          rescue: async (f: FoundMessage) => {
            const d = this.at(owner, f);
            if (!d) return undefined;
            Object.assign(d, { folder: 'INBOX', seen: true, flagged: true });
            return { folder: 'INBOX', uid: d.uid, inSpam: false };
          },
          fileAway: async (f: FoundMessage) => {
            const d = this.at(owner, f);
            if (d) d.folder = WARMUP_FOLDER;
          },
          findBounce: async (messageId: string): Promise<BounceReport | null> =>
            this.bounces.get(messageId) === owner
              ? { status: '5.7.708', diagnostic: '550 5.7.708 Access denied' }
              : null,
          close: async () => undefined,
        };
      },
    };
  }
}

describeIntegration('warmup engine + routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;
  let domainId: string;
  const mailboxIds: string[] = [];
  const emailById = new Map<string, string>();
  const stamp = Date.now();
  const t0 = new Date(Math.floor(Date.now() / DAY) * DAY + HOUR); // 01:00 UTC today
  const clock = { now: t0 };
  let world: MailWorld;

  async function makeMailbox(
    local: string,
    domain: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string; email: string }> {
    const email = `${local}-${stamp}@${domain}`;
    const m = await prisma.mailbox.create({
      data: {
        email,
        domainId,
        smtpHost: 'smtp.fake.test',
        imapHost: 'imap.fake.test',
        imapPort: 993,
        authUsername: email,
        authPasswordEncrypted: 'placeholder-never-decrypted',
        ...extra,
      },
    });
    mailboxIds.push(m.id);
    emailById.set(m.id, email);
    return { id: m.id, email };
  }

  async function seedMessages(
    senderMailboxId: string,
    recipientEmail: string,
    placement: 'INBOX' | 'SPAM',
    n: number,
  ) {
    await prisma.warmupMessage.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        senderMailboxId,
        recipientEmail,
        subject: 'Seeded history',
        messageId: `<seed-${senderMailboxId}-${placement}-${i}@fake.test>`,
        sentAt: new Date(t0.getTime() - (i + 1) * HOUR),
        placement,
        rescued: placement === 'SPAM',
        checkedAt: t0,
      })),
    });
  }

  const auth = () => ({ authorization: `Bearer ${authToken}` });
  const ourMessages = () =>
    prisma.warmupMessage.findMany({
      where: { senderMailboxId: { in: mailboxIds } },
      orderBy: { sentAt: 'asc' },
    });

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    process.env.NEXTJS_CALLBACK_SECRET = CALLBACK_SECRET;
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('m'.repeat(32)).toString('base64');
    app = await createApp();
    await app.ready();
    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.org', role: 'ADMIN' },
      process.env.JWT_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: '1h',
      },
    );
    const domain = await prisma.domain.create({
      data: { domainName: `warmup-test-${stamp}.example.com` },
    });
    domainId = domain.id;
    world = new MailWorld(emailById);
  });

  afterAll(async () => {
    await prisma.warmupMessage.deleteMany({ where: { senderMailboxId: { in: mailboxIds } } });
    await prisma.mailbox.deleteMany({ where: { id: { in: mailboxIds } } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------------------------
  // auth + edge cases that must hold before anything is set up
  // ---------------------------------------------------------------------------------------------

  it('guards the n8n trigger with the callback secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/warmup/tick', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('guards the dashboard routes with a login', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/warmup' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a send test when a lone mailbox has nobody to send to (the 1-mailbox buyer)', async () => {
    const pool = await prisma.mailbox.count({
      where: { imapHost: { not: null }, status: { not: 'PAUSED' } },
    });
    const seeds = await prisma.seedAccount.count({ where: { isActive: true } });
    const lone = await makeMailbox('lone', 'solo.test');
    if (pool + seeds > 0) return; // shared DB with other partners: the 409 case can't be staged
    const res = await app.inject({
      method: 'POST',
      url: `/v1/warmup/${lone.id}/send-now`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Add a second mailbox or a test inbox/);

    const overview = (
      await app.inject({ method: 'GET', url: '/v1/warmup', headers: auth() })
    ).json();
    const row = overview.mailboxes.find((m: { mailboxId: string }) => m.mailboxId === lone.id);
    expect(row.stage).toBe('waiting_for_partner');
    expect(row.nextStep).toBe('Add a second mailbox or a test inbox');
  });

  it('returns 404 / 422 for a missing or unconnected mailbox', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/warmup/nope/send-now',
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);
    const msgs = await app.inject({
      method: 'GET',
      url: '/v1/warmup/nope/messages',
      headers: auth(),
    });
    expect(msgs.statusCode).toBe(404);

    const bare = await makeMailbox('bare', 'bare.test', { authPasswordEncrypted: null });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/warmup/${bare.id}/send-now`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/not fully connected/);
  });

  // ---------------------------------------------------------------------------------------------
  // the loop: send -> check -> rescue -> missing -> unchecked
  // ---------------------------------------------------------------------------------------------

  it('tick 1 sends one warmup email from each connected mailbox to a partner on another domain', async () => {
    await prisma.mailbox.deleteMany({ where: { email: { startsWith: 'lone-' + stamp } } });
    const a = await makeMailbox('alex', 'alpha.test');
    const b = await makeMailbox('bea', 'beta.test');
    world.spamFor.add(a.email); // anything sent to alex lands in Junk

    const summary = await runWarmupTick(world.deps(clock));
    expect(summary.skipped).toBeUndefined();

    const msgs = await ourMessages();
    const fromA = msgs.filter((m) => m.senderMailboxId === a.id);
    const fromB = msgs.filter((m) => m.senderMailboxId === b.id);
    expect(fromA).toHaveLength(1);
    expect(fromB).toHaveLength(1);
    expect(fromA[0].recipientEmail).toBe(b.email);
    expect(fromA[0].recipientMailboxId).toBe(b.id);
    expect(fromB[0].recipientEmail).toBe(a.email);
    expect(fromA[0].placement).toBe('PENDING');
    expect(fromA[0].messageId).toMatch(/^<warm-\d+@fake\.test>$/);

    const started = await prisma.mailbox.findUniqueOrThrow({ where: { id: a.id } });
    expect(started.warmupStartedAt?.getTime()).toBe(t0.getTime());

    // the 'bare' mailbox has no credential -> never sends
    const bare = mailboxIds.find((id) => emailById.get(id)?.startsWith('bare-'));
    expect(msgs.some((m) => m.senderMailboxId === bare)).toBe(false);
  });

  it('tick 2 a minute later neither checks (too soon) nor sends again (spacing)', async () => {
    clock.now = new Date(t0.getTime() + MIN);
    const before = (await ourMessages()).length;
    await runWarmupTick(world.deps(clock));
    const after = await ourMessages();
    expect(after).toHaveLength(before);
    expect(after.every((m) => m.placement === 'PENDING')).toBe(true);
  });

  it('tick 3 finds each email: inbox is marked read, spam is rescued to the inbox', async () => {
    clock.now = new Date(t0.getTime() + 5 * MIN);
    const summary = await runWarmupTick(world.deps(clock));
    expect(summary.checked).toBeGreaterThanOrEqual(2);
    expect(summary.rescued).toBeGreaterThanOrEqual(1);

    const msgs = await ourMessages();
    const toBea = msgs.find((m) => m.recipientEmail.startsWith('bea-'))!;
    const toAlex = msgs.find((m) => m.recipientEmail.startsWith('alex-'))!;
    expect(toBea.placement).toBe('INBOX');
    expect(toBea.foundFolder).toBe('INBOX');
    expect(toBea.rescued).toBe(false);
    expect(toAlex.placement).toBe('SPAM');
    expect(toAlex.foundFolder).toBe('Junk');
    expect(toAlex.rescued).toBe(true);

    // the fake mailbox state changed the way a person's would, then both were filed away
    expect(world.delivered.get(toBea.messageId!)).toMatchObject({
      folder: WARMUP_FOLDER,
      seen: true,
    });
    expect(world.delivered.get(toAlex.messageId!)).toMatchObject({
      folder: WARMUP_FOLDER,
      seen: true,
      flagged: true,
    });
  });

  it('marks an email MISSING once it has not arrived anywhere for 2 hours', async () => {
    const alex = mailboxIds.find((id) => emailById.get(id)?.startsWith('alex-'))!;
    const beaEmail = [...emailById.values()].find((e) => e.startsWith('bea-'))!;
    world.dropFor.add(beaEmail);

    clock.now = new Date(t0.getTime() + 9 * HOUR); // day-1 target 2 -> 8h gap has passed
    await runWarmupTick(world.deps(clock));
    const dropped = (await ourMessages()).filter(
      (m) => m.senderMailboxId === alex && m.placement === 'PENDING',
    );
    expect(dropped).toHaveLength(1);

    clock.now = new Date(t0.getTime() + 9 * HOUR + 30 * MIN);
    await runWarmupTick(world.deps(clock));
    expect(
      (await prisma.warmupMessage.findUniqueOrThrow({ where: { id: dropped[0].id } })).placement,
    ).toBe('PENDING');

    clock.now = new Date(t0.getTime() + 11 * HOUR + MIN);
    await runWarmupTick(world.deps(clock));
    const after = await prisma.warmupMessage.findUniqueOrThrow({ where: { id: dropped[0].id } });
    expect(after.placement).toBe('MISSING');
    expect(after.checkedAt).not.toBeNull();
    world.dropFor.delete(beaEmail);
  });

  it('marks an email UNCHECKED (not counted against health) when the recipient cannot be read for 6 hours', async () => {
    const bea = mailboxIds.find((id) => emailById.get(id)?.startsWith('bea-'))!;
    const alexEmail = [...emailById.values()].find((e) => e.startsWith('alex-'))!;
    const alex = mailboxIds.find((id) => emailById.get(id) === alexEmail)!;
    world.brokenReaders.add(alex);
    const row = await prisma.warmupMessage.create({
      data: {
        senderMailboxId: bea,
        recipientMailboxId: alex,
        recipientEmail: alexEmail,
        subject: 'Unreadable',
        messageId: '<unreadable@fake.test>',
        sentAt: new Date(clock.now.getTime() - 7 * HOUR),
      },
    });
    await runWarmupTick(world.deps(clock));
    const after = await prisma.warmupMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.placement).toBe('UNCHECKED');
    expect(after.error).toMatch(/IMAP login failed/);
    world.brokenReaders.delete(alex);
  });

  it('marks an email BOUNCED with a readable reason when a failure report came back to the sender', async () => {
    const beaEmail = [...emailById.values()].find((e) => e.startsWith('bea-'))!;
    const bea = mailboxIds.find((id) => emailById.get(id) === beaEmail)!;
    const alexEmail = [...emailById.values()].find((e) => e.startsWith('alex-'))!;
    const alex = mailboxIds.find((id) => emailById.get(id) === alexEmail)!;
    const row = await prisma.warmupMessage.create({
      data: {
        senderMailboxId: bea,
        recipientMailboxId: alex,
        recipientEmail: alexEmail,
        subject: 'Blocked on the way out',
        messageId: '<bounced@fake.test>',
        sentAt: new Date(clock.now.getTime() - 3 * HOUR),
      },
    });
    world.bounces.set('<bounced@fake.test>', beaEmail);
    const summary = await runWarmupTick(world.deps(clock));
    expect(summary.bounced).toBeGreaterThanOrEqual(1);
    const after = await prisma.warmupMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.placement).toBe('BOUNCED');
    expect(after.checkedAt).not.toBeNull();
    expect(after.error).toMatch(/^Microsoft 365 blocked this email .* \(5\.7\.708\)/);

    const log = await app.inject({
      method: 'GET',
      url: `/v1/warmup/${bea}/messages?result=bounced`,
      headers: auth(),
    });
    expect(log.statusCode).toBe(200);
    expect(log.json().messages.map((m: { id: string }) => m.id)).toEqual([row.id]);

    const overview = await app.inject({ method: 'GET', url: '/v1/warmup', headers: auth() });
    const view = overview.json().mailboxes.find((m: { mailboxId: string }) => m.mailboxId === bea);
    expect(view.counts.bounced).toBe(1);
    expect(view.lastBounce).toEqual({ at: row.sentAt.toISOString(), reason: after.error });
    expect(view.nextStep).toBe('1 bounced in 7 days. Open the send log to see why.');
    world.bounces.delete('<bounced@fake.test>');
  });

  it('shows the send log and the overview for a warming mailbox', async () => {
    const alex = mailboxIds.find((id) => emailById.get(id)?.startsWith('alex-'))!;
    const log = await app.inject({
      method: 'GET',
      url: `/v1/warmup/${alex}/messages`,
      headers: auth(),
    });
    expect(log.statusCode).toBe(200);
    const { messages } = log.json();
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]).toHaveProperty('placement');
    expect(messages[0]).not.toHaveProperty('messageId');
    expect(new Date(messages[0].sentAt).getTime()).toBeGreaterThanOrEqual(
      new Date(messages[1].sentAt).getTime(),
    );

    const overview = await app.inject({ method: 'GET', url: '/v1/warmup', headers: auth() });
    expect(overview.statusCode).toBe(200);
    const row = overview.json().mailboxes.find((m: { mailboxId: string }) => m.mailboxId === alex);
    expect(row).toMatchObject({ stage: 'warming', status: 'WARMUP', warmupEnabled: true, day: 1 });
    expect(row.counts.inbox + row.counts.missing).toBeGreaterThanOrEqual(2);
    expect(row.health).toBe(Math.round((row.counts.inbox / row.checked) * 100));
    expect(row.partnerCount).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------------------------
  // decide: graduate, demote, pause
  // ---------------------------------------------------------------------------------------------

  it('graduates a mailbox at >=90% over >=20 checked emails after 14 days, then ramps its campaign cap', async () => {
    const bea = [...emailById.values()].find((e) => e.startsWith('bea-'))!;
    const g = await makeMailbox('gus', 'gamma.test', {
      warmupStartedAt: new Date(clock.now.getTime() - 15 * DAY),
    });
    await seedMessages(g.id, bea, 'INBOX', 19);
    await seedMessages(g.id, bea, 'SPAM', 1);

    const summary = await runWarmupTick(world.deps(clock));
    expect(summary.graduated).toBeGreaterThanOrEqual(1);
    const after = await prisma.mailbox.findUniqueOrThrow({ where: { id: g.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.warmupGraduatedAt?.getTime()).toBe(clock.now.getTime());

    const overview = (
      await app.inject({ method: 'GET', url: '/v1/warmup', headers: auth() })
    ).json();
    const row = overview.mailboxes.find((m: { mailboxId: string }) => m.mailboxId === g.id);
    expect(row.stage).toBe('graduated');
    expect(row.campaignCapToday).toBeLessThan(row.dailyCap);
    expect(row.nextStep).toMatch(/^Campaign cap today: \d+ of 25$/);
    expect(overview.summary.graduated).toBeGreaterThanOrEqual(1);
  });

  it('does not graduate a mailbox that is healthy but too new', async () => {
    const bea = [...emailById.values()].find((e) => e.startsWith('bea-'))!;
    const y = await makeMailbox('yan', 'young.test', {
      warmupStartedAt: new Date(clock.now.getTime() - 5 * DAY),
    });
    await seedMessages(y.id, bea, 'INBOX', 30);
    await runWarmupTick(world.deps(clock));
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: y.id } })).status).toBe('WARMUP');
  });

  it('demotes a graduated mailbox back to warmup when its inbox rate falls under 70%', async () => {
    const bea = [...emailById.values()].find((e) => e.startsWith('bea-'))!;
    const d = await makeMailbox('dee', 'delta.test', {
      status: 'ACTIVE',
      warmupStartedAt: new Date(clock.now.getTime() - 30 * DAY),
      warmupGraduatedAt: new Date(clock.now.getTime() - 10 * DAY),
    });
    await seedMessages(d.id, bea, 'INBOX', 5);
    await seedMessages(d.id, bea, 'SPAM', 6);

    const summary = await runWarmupTick(world.deps(clock));
    expect(summary.demoted).toBeGreaterThanOrEqual(1);
    const after = await prisma.mailbox.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.status).toBe('WARMUP');
    expect(after.warmupGraduatedAt).toBeNull();
  });

  it('never touches a mailbox the customer activated by hand without warmup data', async () => {
    const m = await makeMailbox('hand', 'hand.test', { status: 'ACTIVE', warmupEnabled: false });
    await runWarmupTick(world.deps(clock));
    const after = await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } });
    expect(after.status).toBe('ACTIVE');
    expect(await prisma.warmupMessage.count({ where: { senderMailboxId: m.id } })).toBe(0);
  });

  it('stops sending for a mailbox once the customer pauses its warmup', async () => {
    const alex = mailboxIds.find((id) => emailById.get(id)?.startsWith('alex-'))!;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/mailboxes/${alex}`,
      headers: auth(),
      payload: { warmupEnabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().warmupEnabled).toBe(false);

    const bad = await app.inject({
      method: 'PATCH',
      url: `/v1/mailboxes/${alex}`,
      headers: auth(),
      payload: { warmupEnabled: 'no' },
    });
    expect(bad.statusCode).toBe(400);

    const before = await prisma.warmupMessage.count({ where: { senderMailboxId: alex } });
    clock.now = new Date(clock.now.getTime() + 20 * HOUR);
    await runWarmupTick(world.deps(clock));
    expect(await prisma.warmupMessage.count({ where: { senderMailboxId: alex } })).toBe(before);

    const overview = (
      await app.inject({ method: 'GET', url: '/v1/warmup', headers: auth() })
    ).json();
    const row = overview.mailboxes.find((m: { mailboxId: string }) => m.mailboxId === alex);
    expect(row.stage).toBe('paused');
    expect(row.nextStep).toBe('Warmup is paused');
  });

  it('records a failed send as FAILED with the provider error, and it never counts toward health', async () => {
    const bea = mailboxIds.find((id) => emailById.get(id)?.startsWith('bea-'))!;
    const deps = world.deps(clock);
    deps.send = async () => {
      throw new Error('535 5.7.8 Authentication failed');
    };
    clock.now = new Date(clock.now.getTime() + 20 * HOUR);
    const summary = await runWarmupTick(deps);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    const failed = await prisma.warmupMessage.findFirstOrThrow({
      where: { senderMailboxId: bea, placement: 'FAILED' },
    });
    expect(failed.error).toMatch(/535/);
    expect(failed.messageId).toBeNull();
  });

  it('runs a tick through the n8n trigger with the secret', async () => {
    // Pause every test mailbox first so the real tick has nothing of ours to send.
    await prisma.mailbox.updateMany({
      where: { id: { in: mailboxIds } },
      data: { warmupEnabled: false },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/warmup/tick',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sent: expect.any(Number), checked: expect.any(Number) });
  });
});

describeIntegration('warmup sends spread across inboxes + Promotions tab (integration)', () => {
  let app: FastifyInstance;
  let authToken: string;
  let domainId: string;
  const ids: string[] = [];
  const emailById = new Map<string, string>();
  const stamp = Date.now() + 1;
  // Its own day, well clear of the first block's clock.
  const t0 = new Date(Math.floor(Date.now() / DAY) * DAY + 3 * DAY + HOUR);
  const clock = { now: t0 };
  let world: MailWorld;

  async function makeMailbox(local: string, extra: Record<string, unknown> = {}) {
    const email = `${local}-${stamp}@${local}-spread.test`;
    const m = await prisma.mailbox.create({
      data: {
        email,
        domainId,
        smtpHost: 'smtp.fake.test',
        imapHost: 'imap.fake.test',
        imapPort: 993,
        authUsername: email,
        authPasswordEncrypted: 'placeholder-never-decrypted',
        ...extra,
      },
    });
    ids.push(m.id);
    emailById.set(m.id, email);
    return { id: m.id, email };
  }

  const ours = (since: Date) =>
    prisma.warmupMessage.findMany({
      where: { senderMailboxId: { in: ids }, sentAt: { gte: since } },
      orderBy: { sentAt: 'asc' },
    });
  const auth = () => ({ authorization: `Bearer ${authToken}` });

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('m'.repeat(32)).toString('base64');
    app = await createApp();
    await app.ready();
    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.org', role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    const domain = await prisma.domain.create({
      data: { domainName: `warmup-spread-${stamp}.example.com` },
    });
    domainId = domain.id;
    world = new MailWorld(emailById);
  });

  afterAll(async () => {
    await prisma.warmupMessage.deleteMany({ where: { senderMailboxId: { in: ids } } });
    await prisma.mailbox.deleteMany({ where: { id: { in: ids } } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  it('never sends two warmup emails to one inbox in the same tick, and the one left out sends next tick', async () => {
    // Four mailboxes on four domains: with no spreading, three of them pick the same first
    // partner (the 10-09 burst: three senders hitting one Gmail inbox in the same second).
    const boxes = await Promise.all(['ana', 'ben', 'cal', 'dot'].map((l) => makeMailbox(l)));
    const ourEmails = new Set(boxes.map((b) => b.email));

    await runWarmupTick(world.deps(clock));
    const first = (await ours(t0)).filter((m) => ourEmails.has(m.recipientEmail));
    const recipients = first.map((m) => m.recipientEmail);
    expect(new Set(recipients).size).toBe(recipients.length);
    expect(first.length).toBeGreaterThanOrEqual(boxes.length - 1);
    for (const m of first) {
      expect(m.recipientEmail).not.toBe(emailById.get(m.senderMailboxId));
    }

    // Next tick: every mailbox has sent, and still no inbox got two in one tick.
    clock.now = new Date(t0.getTime() + 10 * MIN);
    await runWarmupTick(world.deps(clock));
    const all = await ours(t0);
    expect(new Set(all.map((m) => m.senderMailboxId))).toEqual(new Set(boxes.map((b) => b.id)));
    const tick2 = all.filter((m) => m.sentAt.getTime() === clock.now.getTime());
    expect(new Set(tick2.map((m) => m.recipientEmail)).size).toBe(tick2.length);
  });

  it('skips an inbox that got a warmup email from anyone in the last 5 minutes', async () => {
    const eve = await makeMailbox('eve');
    const fay = await makeMailbox('fay');
    const busyAt = new Date(clock.now.getTime() + 20 * MIN);
    // eve wrote to everyone but fay this morning, so fay is the partner she'd pick next...
    await prisma.warmupMessage.createMany({
      data: ids
        .filter((id) => id !== eve.id && id !== fay.id)
        .map((id, i) => ({
          senderMailboxId: eve.id,
          recipientMailboxId: id,
          recipientEmail: emailById.get(id)!,
          subject: 'Morning',
          messageId: `<morning-${stamp}-${i}@fake.test>`,
          sentAt: new Date(busyAt.getTime() - 12 * HOUR),
          placement: 'INBOX' as const,
          checkedAt: new Date(busyAt.getTime() - 12 * HOUR),
        })),
    });
    // ...but fay got a warmup email from another mailbox 2 minutes before the tick.
    await prisma.warmupMessage.create({
      data: {
        senderMailboxId: ids[0],
        recipientMailboxId: fay.id,
        recipientEmail: fay.email,
        subject: 'Earlier',
        messageId: `<busy-${stamp}@fake.test>`,
        sentAt: new Date(busyAt.getTime() - 2 * MIN),
      },
    });
    clock.now = busyAt;
    await runWarmupTick(world.deps(clock));
    const tick = (await ours(busyAt)).filter((m) => m.sentAt.getTime() === busyAt.getTime());
    expect(tick.some((m) => m.recipientEmail === fay.email)).toBe(false);
    const fromEve = tick.find((m) => m.senderMailboxId === eve.id);
    expect(fromEve).toBeDefined();
    expect(fromEve!.recipientEmail).not.toBe(fay.email);
  });

  it('does not reuse a subject the inbox got from any sender in the last 3 days', async () => {
    const { WARMUP_SUBJECTS } = await import('../../lib/warmup/composer');
    // History comes from a paused mailbox, so it neither sends nor counts as a partner.
    const hist = await makeMailbox('hist', { status: 'PAUSED' });
    const at = new Date(clock.now.getTime() + 20 * HOUR);
    const left = WARMUP_SUBJECTS[0];
    const recipients = ids.filter((id) => id !== hist.id).map((id) => emailById.get(id)!);
    await prisma.warmupMessage.createMany({
      data: recipients.flatMap((to, r) =>
        WARMUP_SUBJECTS.filter((s) => s !== left).map((subject, i) => ({
          senderMailboxId: hist.id,
          recipientEmail: to,
          subject,
          messageId: `<hist-${stamp}-${r}-${i}@fake.test>`,
          sentAt: new Date(at.getTime() - 2 * DAY + i * MIN),
          placement: 'INBOX' as const,
          checkedAt: at,
        })),
      ),
    });
    clock.now = at;
    await runWarmupTick(world.deps(clock));
    const sent = (await ours(at)).filter(
      (m) => m.sentAt.getTime() === at.getTime() && m.senderMailboxId !== hist.id,
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) {
      if (recipients.includes(m.recipientEmail)) expect(m.subject).toBe(left);
    }
  });

  it('records a Gmail Promotions-tab landing as PROMOTIONS, files it away, and counts it against the inbox rate', async () => {
    const gil = await makeMailbox('gil');
    world.promotionsFor.add(gil.email);
    clock.now = new Date(clock.now.getTime() + 20 * HOUR);
    const sentAt = clock.now;
    await runWarmupTick(world.deps(clock));
    const toGil = (await ours(sentAt)).filter((m) => m.recipientEmail === gil.email);
    expect(toGil).toHaveLength(1);

    clock.now = new Date(sentAt.getTime() + 10 * MIN);
    await runWarmupTick(world.deps(clock));
    const after = await prisma.warmupMessage.findUniqueOrThrow({ where: { id: toGil[0].id } });
    expect(after.placement).toBe('PROMOTIONS');
    expect(after.foundFolder).toBe('INBOX');
    expect(after.rescued).toBe(false);
    expect(world.delivered.get(after.messageId!)).toMatchObject({
      folder: WARMUP_FOLDER,
      seen: true,
      flagged: false,
    });

    const sender = after.senderMailboxId;
    const log = await app.inject({
      method: 'GET',
      url: `/v1/warmup/${sender}/messages?result=promotions`,
      headers: auth(),
    });
    expect(log.statusCode).toBe(200);
    expect(log.json().messages.map((m: { id: string }) => m.id)).toContain(after.id);
    const inboxOnly = await app.inject({
      method: 'GET',
      url: `/v1/warmup/${sender}/messages?result=inbox`,
      headers: auth(),
    });
    expect(inboxOnly.json().messages.map((m: { id: string }) => m.id)).not.toContain(after.id);

    const overview = (
      await app.inject({ method: 'GET', url: '/v1/warmup', headers: auth() })
    ).json();
    const row = overview.mailboxes.find((m: { mailboxId: string }) => m.mailboxId === sender);
    expect(row.counts.promotions).toBeGreaterThanOrEqual(1);
    expect(row.checked).toBe(
      row.counts.inbox +
        row.counts.promotions +
        row.counts.spam +
        row.counts.missing +
        row.counts.bounced,
    );
    expect(row.health).toBe(Math.round((row.counts.inbox / row.checked) * 100));
    expect(row.health).toBeLessThan(100);
    world.promotionsFor.delete(gil.email);
  });

  it('falls back to INBOX when the Promotions lookup fails', async () => {
    const hal = await makeMailbox('hal');
    world.promotionsFor.add(hal.email);
    world.promotionsErrorFor.add(hal.email);
    clock.now = new Date(clock.now.getTime() + 20 * HOUR);
    const sentAt = clock.now;
    await runWarmupTick(world.deps(clock));
    const toHal = (await ours(sentAt)).filter((m) => m.recipientEmail === hal.email);
    expect(toHal).toHaveLength(1);

    clock.now = new Date(sentAt.getTime() + 10 * MIN);
    await runWarmupTick(world.deps(clock));
    const after = await prisma.warmupMessage.findUniqueOrThrow({ where: { id: toHal[0].id } });
    expect(after.placement).toBe('INBOX');
    expect(after.error).toBeNull();
    expect(world.delivered.get(after.messageId!)?.folder).toBe(WARMUP_FOLDER);
  });

  it('rejects an unknown result filter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/warmup/${ids[0]}/messages?result=primary`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });
});
