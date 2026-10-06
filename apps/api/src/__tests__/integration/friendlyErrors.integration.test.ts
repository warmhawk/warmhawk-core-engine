/**
 * What a person reads when an action fails (lib/friendlyError.ts), end to end against a REAL
 * Postgres: the dashboard shows core's `{ error }` text in its popups, so none of these may carry
 * Prisma, multipart, CSV-parser or SMTP wording. Each case drives the real route the dashboard
 * calls, with a real database constraint, a real oversized upload or a real SMTP conversation.
 */
import net from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { encrypt, loadEncryptionKey } from '../../lib/encryption';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

/** Nothing a person should ever see in a popup. */
const TECHNICAL =
  /prisma|invocation|constraint|P20\d\d|FST_|ECONN|ESOCKET|EAUTH|535|5\.7\.8|stack/i;

/** An SMTP server that greets, offers AUTH and then refuses the password, the way Gmail does for
 *  a revoked app password. */
async function startRejectingSmtpServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.write('220 reject.test ESMTP\r\n');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let index: number;
      while ((index = buffered.indexOf('\r\n')) !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          socket.write('250-reject.test\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (verb === 'AUTH') {
          socket.write('535 5.7.8 Username and Password not accepted\r\n');
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
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A port on this machine that nothing listens on. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function multipart(campaignId: string, filename: string, content: string | Buffer) {
  const boundary = `----WarmHawkFriendlyErrors${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="campaignId"\r\n\r\n${campaignId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(content), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describeIntegration('friendly error messages (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;
  let rejectingSmtp: { port: number; close: () => Promise<void> };
  let domainId: string;
  const mailboxIds: string[] = [];
  const campaignIds: string[] = [];
  const domainIds: string[] = [];
  const savedWarmhawkDomain = process.env.WARMHAWK_DOMAIN;

  const auth = () => ({ authorization: `Bearer ${authToken}` });

  /** A campaign with one sender whose SMTP lives at `port` — what "Send me a test" sends from. */
  async function campaignSendingVia(port: number, label: string): Promise<string> {
    const key = loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY ?? '');
    const mailbox = await prisma.mailbox.create({
      data: {
        email: `friendly-${label}-${Date.now()}@example.com`,
        domainId,
        status: 'ACTIVE',
        smtpHost: '127.0.0.1',
        smtpPort: port,
        authUsername: 'friendly-user',
        authPasswordEncrypted: encrypt('not-the-real-password', key),
      },
    });
    mailboxIds.push(mailbox.id);
    const campaign = await prisma.campaign.create({
      data: {
        name: `Friendly errors ${label}`,
        aiPromptTemplate: '',
        subject: 'Quick question',
        template: 'Hi {{firstName}}, a short note.',
      },
    });
    campaignIds.push(campaign.id);
    await prisma.campaignMailbox.create({
      data: { campaignId: campaign.id, mailboxId: mailbox.id },
    });
    return campaign.id;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('f'.repeat(32)).toString('base64');
    // The built-in unsubscribe page needs the install's domain; a test send refuses without one.
    process.env.WARMHAWK_DOMAIN = 'api.friendly.example';
    rejectingSmtp = await startRejectingSmtpServer();
    app = await createApp();
    await app.ready();

    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.org', role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const domain = await prisma.domain.create({
      data: {
        domainName: `friendly-errors-${Date.now()}.example.com`,
        mailingAddress: '100 Example Street, Springfield, ST 00000',
      },
    });
    domainId = domain.id;
    domainIds.push(domain.id);
  });

  afterAll(async () => {
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.mailbox.deleteMany({ where: { id: { in: mailboxIds } } });
    await prisma.domain.deleteMany({ where: { id: { in: domainIds } } });
    await rejectingSmtp.close();
    await app.close();
    await prisma.$disconnect();
    if (savedWarmhawkDomain === undefined) delete process.env.WARMHAWK_DOMAIN;
    else process.env.WARMHAWK_DOMAIN = savedWarmhawkDomain;
  });

  it('a mailbox that is already connected says so (database unique constraint)', async () => {
    const email = `friendly-dupe-${Date.now()}@example.com`;
    const create = () =>
      app.inject({
        method: 'POST',
        url: '/v1/mailboxes',
        headers: auth(),
        payload: { email, domainId },
      });
    const first = await create();
    expect(first.statusCode).toBe(201);
    mailboxIds.push(first.json().id);

    const second = await create();
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('This mailbox is already connected.');
  });

  it('a mailbox for a domain that no longer exists asks for a reload (foreign key)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mailboxes',
      headers: auth(),
      payload: {
        email: `friendly-orphan-${Date.now()}@example.com`,
        domainId: 'deleted-domain-id',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/Reload the page/);
    expect(response.json().error).not.toMatch(TECHNICAL);
  });

  it('a domain that is already added names it', async () => {
    const domainName = `friendly-dupe-${Date.now()}.example.com`;
    const create = () =>
      app.inject({ method: 'POST', url: '/v1/domains', headers: auth(), payload: { domainName } });
    const first = await create();
    domainIds.push(first.json().id);

    const second = await create();
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe(`${domainName} is already added`);
  });

  it('broken { | } word choices are explained in words, on create and on edit', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: auth(),
      payload: { name: 'Friendly spintax', aiPromptTemplate: '', template: '{Hi|Hello there' },
    });
    expect(created.statusCode).toBe(422);
    expect(created.json().error).toBe(
      'This email has a "{" that is never closed with "}". Word choices are written like {Hi|Hello} — fix the braces and try again.',
    );

    const campaign = await prisma.campaign.create({
      data: { name: 'Friendly spintax edit', aiPromptTemplate: '', template: 'Hi' },
    });
    campaignIds.push(campaign.id);
    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${campaign.id}`,
      headers: auth(),
      payload: { template: 'Hi there}' },
    });
    expect(edited.statusCode).toBe(422);
    expect(edited.json().error).toMatch(/^This email has a "}" without a matching "{"/);
  });

  it('a file that is not a readable CSV says what to fix', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Friendly CSV', aiPromptTemplate: '' },
    });
    campaignIds.push(campaign.id);
    const { payload, contentType } = multipart(
      campaign.id,
      'leads.csv',
      'email,company\n"a@example.org,Acme\nb@example.org,Beta\n',
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/leads/import',
      headers: { ...auth(), 'content-type': contentType },
      payload,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatch(/^This file couldn't be read as a CSV/);
    expect(response.json().error).not.toMatch(/Quote|Invalid Opening|CSV_/);
  });

  it('a file over the upload limit says the limit (Fastify multipart error)', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Friendly big CSV', aiPromptTemplate: '' },
    });
    campaignIds.push(campaign.id);
    const big = Buffer.alloc(10 * 1024 * 1024 + 1024, 'a');
    const { payload, contentType } = multipart(campaign.id, 'big.csv', big);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/leads/import',
      headers: { ...auth(), 'content-type': contentType },
      payload,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe('That file is too large. The limit is 10 MB.');
  });

  it('a test send the mail server refuses the login for asks for a reconnect', async () => {
    const campaignId = await campaignSendingVia(rejectingSmtp.port, 'auth');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${campaignId}/test-send`,
      headers: auth(),
      payload: { to: 'me@example.org' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe(
      "The mail server rejected this mailbox's sign-in. Reconnect it, or add it again with a new app password.",
    );
  });

  it('a test send to a mail server that is not there points at host and port', async () => {
    const campaignId = await campaignSendingVia(await closedPort(), 'down');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${campaignId}/test-send`,
      headers: auth(),
      payload: { to: 'me@example.org' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatch(/Check its SMTP host and port/);
    expect(response.json().error).not.toMatch(TECHNICAL);
  });
});
