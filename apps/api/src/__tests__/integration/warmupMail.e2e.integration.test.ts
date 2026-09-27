/**
 * End-to-end warmup test over REAL SMTP and IMAP — a GreenMail server in Docker — plus a real
 * Postgres. Nothing about mail is faked: `runWarmupTick` with the production `defaultWarmupDeps`
 * sends through `sendMail()` (nodemailer SMTP), then reads the recipient mailbox over IMAPS
 * (`openImapClient`), marks inbox mail read and rescues spam back to the inbox.
 *
 * Self-skips unless both DATABASE_URL and WARMUP_E2E_SMTP_PORT are set. To run locally:
 *
 *   docker run -d --name wh-warmup-greenmail -p 127.0.0.1:4625:3025 -p 127.0.0.1:4693:3993 \
 *     -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imaps \
 *       -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled' greenmail/standalone:2.1.3
 *   WARMUP_E2E_SMTP_PORT=4625 WARMUP_E2E_IMAPS_PORT=4693 DATABASE_URL=... \
 *     npx vitest run --config vitest.integration.config.ts warmupMail
 *
 * GreenMail's IMAPS certificate is self-signed, so TLS verification is switched off for this test
 * process only. GreenMail has no spam filter: the test plays the provider's part by moving the
 * delivered message into a `Junk` folder, which `listSpamFolders` finds by name.
 *
 * The last test covers the seed placement sample the same way: a real campaign send, sampled
 * (`SEED_BCC_SAMPLE_RATE=1`), BCCs a GreenMail seed inbox, and the check finds that exact copy by
 * Message-ID even though the seed inbox also holds a newer, unrelated email.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ImapFlow } from 'imapflow';
import { prisma } from '@warmhawk/db';
import { encrypt, loadEncryptionKey } from '../../lib/encryption';
import { defaultWarmupDeps, runWarmupTick, type WarmupDeps } from '../../lib/warmup/engine';
import { sendMail } from '../../lib/mailSender';
import { encryptSeedImapConfig } from '../../lib/seedAccounts';
import { checkSampledPlacements } from '../../lib/seedPlacementPoller';

const SMTP_PORT = Number(process.env.WARMUP_E2E_SMTP_PORT || 0);
const IMAPS_PORT = Number(process.env.WARMUP_E2E_IMAPS_PORT || 4693);
const HOST = process.env.WARMUP_E2E_HOST || '127.0.0.1';
const enabled = Boolean(process.env.DATABASE_URL && SMTP_PORT);
const describeE2e = enabled ? describe : describe.skip;

const MIN = 60 * 1000;
const PASSWORD = 'greenmail-any-password';

function imap(user: string): ImapFlow {
  return new ImapFlow({
    host: HOST,
    port: IMAPS_PORT,
    secure: true,
    auth: { user, pass: PASSWORD },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
}

async function withImap<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = imap(user);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => c.close());
  }
}

/** Every message in a folder with its flags and Message-ID. */
async function listFolder(user: string, folder: string) {
  return withImap(user, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const out: Array<{ uid: number; messageId: string; subject: string; flags: string[] }> = [];
      if (!c.mailbox || c.mailbox.exists === 0) return out;
      for await (const m of c.fetch('1:*', { envelope: true, flags: true })) {
        out.push({
          uid: m.uid,
          messageId: m.envelope?.messageId ?? '',
          subject: m.envelope?.subject ?? '',
          flags: [...(m.flags ?? [])],
        });
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  label: string,
): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describeE2e('warmup over real SMTP + IMAP (GreenMail e2e)', () => {
  const stamp = Date.now();
  const alex = `alex${stamp}@alpha.e2e.test`;
  const bea = `bea${stamp}@beta.e2e.test`;
  let domainId: string;
  const mailboxIds: string[] = [];
  let realTlsSetting: string | undefined;

  const clock = { now: new Date() };
  const deps: WarmupDeps = { ...defaultWarmupDeps, now: () => clock.now, rng: () => 0.3 };

  beforeAll(async () => {
    realTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('m'.repeat(32)).toString('base64');
    const key = loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY);

    // Recipients' folders exist before any mail arrives (GreenMail auto-provisions on login).
    for (const user of [alex, bea]) {
      await withImap(user, async (c) => {
        await c.mailboxCreate('Junk').catch(() => undefined);
      });
    }

    // Only our two mailboxes may warm during this test.
    await prisma.mailbox.updateMany({ data: { warmupEnabled: false } });

    const domain = await prisma.domain.create({
      data: { domainName: `warmup-e2e-${stamp}.example.com` },
    });
    domainId = domain.id;
    for (const email of [alex, bea]) {
      const m = await prisma.mailbox.create({
        data: {
          email,
          domainId,
          provider: 'SMTP_CUSTOM',
          smtpHost: HOST,
          smtpPort: SMTP_PORT,
          imapHost: HOST,
          imapPort: IMAPS_PORT,
          authUsername: email,
          authPasswordEncrypted: encrypt(PASSWORD, key),
        },
      });
      mailboxIds.push(m.id);
    }
  });

  afterAll(async () => {
    await prisma.warmupMessage.deleteMany({ where: { senderMailboxId: { in: mailboxIds } } });
    await prisma.mailbox.deleteMany({ where: { id: { in: mailboxIds } } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await prisma.$disconnect();
    if (realTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = realTlsSetting;
  });

  it('sends a real warmup email each way and records the provider Message-ID', async () => {
    const summary = await runWarmupTick(deps);
    expect(summary).toMatchObject({ sent: 2, failed: 0 });

    const rows = await prisma.warmupMessage.findMany({
      where: { senderMailboxId: { in: mailboxIds } },
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.placement).toBe('PENDING');
      expect(r.messageId).toMatch(/^<.+@.+>$/);
    }

    // Both arrive in the recipients' real INBOXes with the same Message-ID we stored.
    const toBea = rows.find((r) => r.recipientEmail === bea)!;
    const inBea = await waitFor(
      async () => (await listFolder(bea, 'INBOX')).find((m) => m.messageId === toBea.messageId),
      'bea delivery',
    );
    expect(inBea.subject).toBe(toBea.subject);
    expect(inBea.flags).not.toContain('\\Seen');
  });

  it('checks placement over IMAP: marks the inbox copy read and rescues the spam copy', async () => {
    const toAlex = await prisma.warmupMessage.findFirstOrThrow({ where: { recipientEmail: alex } });
    const toBea = await prisma.warmupMessage.findFirstOrThrow({ where: { recipientEmail: bea } });

    // Play the spam filter: alex's provider files the incoming warmup email under Junk.
    const delivered = await waitFor(
      async () => (await listFolder(alex, 'INBOX')).find((m) => m.messageId === toAlex.messageId),
      'alex delivery',
    );
    await withImap(alex, async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        await c.messageMove({ uid: String(delivered.uid) }, 'Junk', { uid: true });
      } finally {
        lock.release();
      }
    });
    expect((await listFolder(alex, 'Junk')).map((m) => m.messageId)).toContain(toAlex.messageId);

    clock.now = new Date(Date.now() + 4 * MIN); // past the 3-minute check delay
    const summary = await runWarmupTick(deps);
    expect(summary).toMatchObject({ checked: 2, rescued: 1, missing: 0, sent: 0 });

    const afterBea = await prisma.warmupMessage.findUniqueOrThrow({ where: { id: toBea.id } });
    expect(afterBea).toMatchObject({
      placement: 'INBOX',
      foundFolder: 'INBOX',
      rescued: false,
      error: null,
    });
    const afterAlex = await prisma.warmupMessage.findUniqueOrThrow({ where: { id: toAlex.id } });
    expect(afterAlex).toMatchObject({
      placement: 'SPAM',
      foundFolder: 'Junk',
      rescued: true,
      error: null,
    });

    // The real mailboxes now look the way a person would have left them.
    const beaInbox = (await listFolder(bea, 'INBOX')).find((m) => m.messageId === toBea.messageId)!;
    expect(beaInbox.flags).toContain('\\Seen');
    expect((await listFolder(alex, 'Junk')).some((m) => m.messageId === toAlex.messageId)).toBe(
      false,
    );
    const rescued = (await listFolder(alex, 'INBOX')).find(
      (m) => m.messageId === toAlex.messageId,
    )!;
    expect(rescued.flags).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']));
  });

  it('still finds an email whose Message-ID the provider rewrote, by sender + subject + time', async () => {
    const sender = mailboxIds[0];
    const sentAt = new Date();
    const subject = `Rewritten id check ${stamp}`;
    // What Microsoft 365 / Graph can do: the copy that lands carries a different Message-ID.
    const raw = [
      `From: ${alex}`,
      `To: ${bea}`,
      `Subject: ${subject}`,
      `Message-ID: <provider-rewrote-${stamp}@outlook.test>`,
      `Date: ${sentAt.toUTCString()}`,
      '',
      'Hi Bea,',
      '',
    ].join('\r\n');
    await withImap(bea, (c) => c.append('INBOX', raw, [], sentAt));

    const row = await prisma.warmupMessage.create({
      data: {
        senderMailboxId: sender,
        recipientMailboxId: mailboxIds[1],
        recipientEmail: bea,
        subject,
        messageId: `<what-we-sent-${stamp}@alpha.e2e.test>`,
        sentAt,
      },
    });

    clock.now = new Date(Date.now() + 4 * MIN);
    await runWarmupTick(deps);
    const after = await prisma.warmupMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.placement).toBe('INBOX');
    expect(after.foundFolder).toBe('INBOX');
  });

  it('samples a campaign send to a seed inbox and finds that exact copy in its spam folder', async () => {
    const seedEmail = `seed${stamp}@gamma.e2e.test`;
    await withImap(seedEmail, (c) => c.mailboxCreate('Junk').catch(() => undefined));
    const realRate = process.env.SEED_BCC_SAMPLE_RATE;
    const realSettings = await prisma.instanceSettings.findUnique({ where: { id: 'default' } });
    process.env.SEED_BCC_SAMPLE_RATE = '1';
    // Only our seed may be BCC'd during this test.
    const otherActiveSeeds = await prisma.seedAccount.findMany({ where: { isActive: true }, select: { id: true } });
    await prisma.seedAccount.updateMany({ data: { isActive: false } });

    const seed = await prisma.seedAccount.create({
      data: {
        provider: 'ZOHO',
        emailAddress: seedEmail,
        imapConfigEncrypted: encryptSeedImapConfig({
          host: HOST,
          port: IMAPS_PORT,
          username: seedEmail,
          password: PASSWORD,
        }),
      },
    });
    await prisma.instanceSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', physicalMailingAddress: '1 Test Way, Testville' },
      update: { physicalMailingAddress: '1 Test Way, Testville' },
    });
    const campaign = await prisma.campaign.create({
      data: {
        name: `Seed e2e ${stamp}`,
        status: 'ACTIVE',
        aiPromptTemplate: '',
        unsubscribeUrlTemplate: 'https://example.com/u?e={{email}}',
      },
    });
    const lead = await prisma.lead.create({
      data: { campaignId: campaign.id, email: bea, status: 'QUEUED' },
    });

    try {
      const subject = `Quick question ${stamp}`;
      const result = await sendMail({
        mailboxId: mailboxIds[0],
        to: bea,
        subject,
        body: 'Hi Bea,\n\nWorth a chat?',
        campaignId: campaign.id,
        leadId: lead.id,
      });
      expect(result.seedBccCount).toBe(1);

      const [row] = await prisma.seedPlacementResult.findMany({ where: { campaignId: campaign.id } });
      expect(row).toMatchObject({ seedAccountId: seed.id, mailboxId: mailboxIds[0], checkedAt: null });
      expect(row.messageId).toMatch(/^<.+@.+>$/);
      expect(row.subjectSha256).toMatch(/^[0-9a-f]{64}$/);

      // The seed's provider files the campaign copy under Junk, then a newer unrelated email
      // arrives in its INBOX — the old poller would have reported that one.
      const copy = await waitFor(
        async () => (await listFolder(seedEmail, 'INBOX')).find((m) => m.messageId === row.messageId),
        'seed delivery',
      );
      await withImap(seedEmail, async (c) => {
        const lock = await c.getMailboxLock('INBOX');
        try {
          await c.messageMove({ uid: String(copy.uid) }, 'Junk', { uid: true });
        } finally {
          lock.release();
        }
        await c.append(
          'INBOX',
          [`From: ${bea}`, `To: ${seedEmail}`, 'Subject: Unrelated', `Message-ID: <later-${stamp}@beta.e2e.test>`, '', 'hi', ''].join('\r\n'),
        );
      });

      const summary = await checkSampledPlacements({
        now: () => new Date(Date.now() + 4 * MIN),
        openReader: defaultWarmupDeps.openReader,
      });
      expect(summary.seedChecked).toBeGreaterThanOrEqual(1);
      const after = await prisma.seedPlacementResult.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.folder).toBe('SPAM');
      expect(after.checkedAt).not.toBeNull();

      // Looked at, never touched: the campaign copy stays unread in Junk.
      const junk = (await listFolder(seedEmail, 'Junk')).find((m) => m.messageId === row.messageId)!;
      expect(junk.flags).not.toContain('\\Seen');
    } finally {
      if (realRate === undefined) delete process.env.SEED_BCC_SAMPLE_RATE;
      else process.env.SEED_BCC_SAMPLE_RATE = realRate;
      await prisma.seedPlacementResult.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.executionLog.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.lead.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.campaign.delete({ where: { id: campaign.id } });
      await prisma.seedAccount.delete({ where: { id: seed.id } });
      await prisma.seedAccount.updateMany({
        where: { id: { in: otherActiveSeeds.map((s) => s.id) } },
        data: { isActive: true },
      });
      if (realSettings) {
        await prisma.instanceSettings.update({
          where: { id: 'default' },
          data: { physicalMailingAddress: realSettings.physicalMailingAddress },
        });
      } else {
        await prisma.instanceSettings.delete({ where: { id: 'default' } });
      }
    }
  });
});
