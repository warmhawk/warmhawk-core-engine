/**
 * "Send me a test" goes to the user, not to the lead it was written for — so its unsubscribe link
 * must not be that lead's. Seen on the box 2026-10-05: the [Test] email carried the first lead's
 * signed link, and clicking Unsubscribe in it would have opted the real lead out. End to end
 * against a REAL Postgres and a real SMTP conversation that keeps what was sent.
 */
import net from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { encrypt, loadEncryptionKey } from '../../lib/encryption';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

/** An SMTP server that takes any login and keeps each message it is handed. */
async function startCapturingSmtpServer(): Promise<{
  port: number;
  messages: string[];
  close: () => Promise<void>;
}> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    socket.write('220 capture.test ESMTP\r\n');
    let buffered = '';
    let data: string[] | null = null;
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let index: number;
      while ((index = buffered.indexOf('\r\n')) !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        if (data) {
          if (line === '.') {
            messages.push(data.join('\r\n'));
            data = null;
            socket.write('250 2.0.0 queued as capture\r\n');
          } else {
            data.push(line);
          }
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          socket.write('250-capture.test\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (verb === 'AUTH') {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (verb === 'DATA') {
          data = [];
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The message as text — quoted-printable soft breaks undone, so a long link reads whole. */
function readable(message: string): string {
  return message.replace(/=\r\n/g, '').replace(/=3D/gi, '=');
}

describeIntegration('test send unsubscribe link (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;
  let smtp: Awaited<ReturnType<typeof startCapturingSmtpServer>>;
  let domainId: string;
  const mailboxIds: string[] = [];
  const campaignIds: string[] = [];
  const stamp = Date.now();
  const tester = `tester-${stamp}@example.org`;
  const leadEmail = `real-lead-${stamp}@acme.example`;
  const savedWarmhawkDomain = process.env.WARMHAWK_DOMAIN;

  const auth = () => ({ authorization: `Bearer ${authToken}` });

  /** A campaign with one real lead and one sender whose SMTP is the capturing server. */
  async function campaignWithLead(unsubscribeUrlTemplate = '') {
    const key = loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY ?? '');
    const mailbox = await prisma.mailbox.create({
      data: {
        email: `test-send-${campaignIds.length}-${stamp}@example.com`,
        domainId,
        status: 'ACTIVE',
        smtpHost: '127.0.0.1',
        smtpPort: smtp.port,
        authUsername: 'capture-user',
        authPasswordEncrypted: encrypt('not-the-real-password', key),
      },
    });
    mailboxIds.push(mailbox.id);
    const campaign = await prisma.campaign.create({
      data: {
        name: `Test send unsubscribe ${campaignIds.length}`,
        aiPromptTemplate: '',
        subject: 'Quick question',
        template: 'Hi {{firstName}}, a short note.',
        unsubscribeUrlTemplate,
      },
    });
    campaignIds.push(campaign.id);
    await prisma.campaignMailbox.create({
      data: { campaignId: campaign.id, mailboxId: mailbox.id },
    });
    const lead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        email: leadEmail,
        firstName: 'Dana',
        status: 'UNTOUCHED',
      },
    });
    return { campaignId: campaign.id, lead };
  }

  async function testSend(campaignId: string): Promise<string> {
    const before = smtp.messages.length;
    const response = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${campaignId}/test-send`,
      headers: auth(),
      payload: { to: tester },
    });
    expect(response.statusCode).toBe(200);
    expect(smtp.messages.length).toBe(before + 1);
    return readable(smtp.messages[before]);
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('f'.repeat(32)).toString('base64');
    process.env.WARMHAWK_DOMAIN = 'api.test-send.example';
    smtp = await startCapturingSmtpServer();
    app = await createApp();
    await app.ready();

    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: tester, role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const domain = await prisma.domain.create({
      data: {
        domainName: `test-send-${stamp}.example.com`,
        mailingAddress: '100 Example Street, Springfield, ST 00000',
      },
    });
    domainId = domain.id;
  });

  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.mailbox.deleteMany({ where: { id: { in: mailboxIds } } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await prisma.suppressionEntry.deleteMany({ where: { email: { in: [leadEmail, tester] } } });
    await smtp.close();
    await app.close();
    await prisma.$disconnect();
    if (savedWarmhawkDomain === undefined) delete process.env.WARMHAWK_DOMAIN;
    else process.env.WARMHAWK_DOMAIN = savedWarmhawkDomain;
  });

  it('a test email links to a test page, and clicking it unsubscribes nobody', async () => {
    const { campaignId, lead } = await campaignWithLead();
    const message = await testSend(campaignId);

    expect(message).toContain('Subject: [Test] Quick question');
    // Written for the real lead...
    expect(message).toContain('Hi Dana');
    // ...but the link isn't theirs.
    expect(message).not.toContain(lead.id);
    const link = message.match(/https:\/\/api\.test-send\.example\/unsubscribe\/(\S+)/);
    expect(link?.[1]).toMatch(/^test-send\./);

    const page = await app.inject({ method: 'GET', url: `/unsubscribe/${link![1]}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('This was a test email');
    expect(page.body).not.toContain(leadEmail);
    expect(page.body).not.toContain('<form');

    // The RFC 8058 one-click POST too: nothing is suppressed.
    const clicked = await app.inject({ method: 'POST', url: `/unsubscribe/${link![1]}` });
    expect(clicked.statusCode).toBe(200);
    expect(clicked.body).toContain('This was a test email');
    expect(await prisma.suppressionEntry.findUnique({ where: { email: leadEmail } })).toBeNull();
    expect(await prisma.suppressionEntry.findUnique({ where: { email: tester } })).toBeNull();
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
      'UNTOUCHED',
    );
  });

  it("a campaign's own unsubscribe link is filled with the tester's address, not the lead's", async () => {
    const { campaignId } = await campaignWithLead('https://unsub.customer.example/out?e={{email}}');
    const message = await testSend(campaignId);

    expect(message).toContain(`https://unsub.customer.example/out?e=${encodeURIComponent(tester)}`);
    expect(message).not.toContain(encodeURIComponent(leadEmail));
  });

  it('the preview still shows the lead their own link', async () => {
    const { campaignId, lead } = await campaignWithLead();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/campaigns/preview',
      headers: auth(),
      payload: { campaignId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().body).toContain(`/unsubscribe/${lead.id}.`);
  });
});
