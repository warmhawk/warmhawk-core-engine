/**
 * `POST /v1/mailboxes` signs in to the SMTP and IMAP servers before saving a password mailbox
 * (lib/mailSignInCheck.ts), against a REAL Postgres and a real SMTP conversation with a server on
 * this machine. A refused sign-in on either server saves nothing and says what to do; mailboxes
 * without a password (OAuth, or a bare row) are never dialed.
 */
import net from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { SIGN_IN_REJECTED } from '../../lib/mailSignInCheck';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

const TECHNICAL =
  /prisma|EAUTH|ECONN|ESOCKET|535|5\.7\.8|nodemailer|imapflow|_TIMEOUT|NoConnection|ERR_/i;

interface FakeSmtp {
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}

/** An SMTP server that accepts (235) or refuses (535) every password, counting connections. */
async function startSmtpServer(acceptPassword: boolean): Promise<FakeSmtp> {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.write('220 fake.test ESMTP\r\n');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let index: number;
      while ((index = buffered.indexOf('\r\n')) !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          socket.write('250-fake.test\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (verb === 'AUTH') {
          socket.write(
            acceptPassword
              ? '235 2.7.0 Accepted\r\n'
              : '535 5.7.8 Username and Password not accepted\r\n',
          );
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
    connections: () => connections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describeIntegration('mailbox SMTP and IMAP sign-in check (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;
  let domainId: string;
  let accepting: FakeSmtp;
  let rejecting: FakeSmtp;
  const createdMailboxIds: string[] = [];

  const create = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { domainId, ...payload },
    });

  // IMAP on a reserved test host (skipped) unless a test points it somewhere real.
  const smtpMailbox = (
    email: string,
    port: number,
    imap: { imapHost: string; imapPort: number } = { imapHost: 'imap.signin.test', imapPort: 993 },
  ) => ({
    email,
    provider: 'SMTP_CUSTOM',
    smtpHost: '127.0.0.1',
    smtpPort: port,
    ...imap,
    authUsername: email,
    authPassword: 'typed-password',
  });

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('s'.repeat(32)).toString('base64');
    accepting = await startSmtpServer(true);
    rejecting = await startSmtpServer(false);
    app = await createApp();
    await app.ready();

    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.org', role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const domain = await prisma.domain.create({
      data: { domainName: `signin-check-${Date.now()}.example.com` },
    });
    domainId = domain.id;
  });

  afterAll(async () => {
    await prisma.mailbox.deleteMany({ where: { id: { in: createdMailboxIds } } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await accepting.close();
    await rejecting.close();
    await app.close();
    await prisma.$disconnect();
  });

  it('saves the mailbox when the server accepts the sign-in', async () => {
    const email = `ok-${Date.now()}@acme.com`;
    const response = await create(smtpMailbox(email, accepting.port));

    expect(response.statusCode).toBe(201);
    createdMailboxIds.push(response.json().id);
    const stored = await prisma.mailbox.findUniqueOrThrow({ where: { email } });
    expect(stored.smtpPort).toBe(accepting.port);
    expect(stored.authPasswordEncrypted).toBeTruthy();
  });

  it('refuses a rejected password with the app-password sentence and saves nothing', async () => {
    const email = `bad-pw-${Date.now()}@acme.com`;
    const response = await create(smtpMailbox(email, rejecting.port));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: SIGN_IN_REJECTED });
    expect(response.body).not.toMatch(TECHNICAL);
    expect(await prisma.mailbox.findUnique({ where: { email } })).toBeNull();
  });

  it('refuses a host and port nothing answers on, naming them', async () => {
    const email = `no-server-${Date.now()}@acme.com`;
    const port = await closedPort();
    const response = await create(smtpMailbox(email, port));

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe(
      `We couldn't connect to 127.0.0.1 on port ${port}. Check the SMTP host and port — most mail servers use 587 or 465.`,
    );
    expect(await prisma.mailbox.findUnique({ where: { email } })).toBeNull();
  });

  it('refuses an IMAP host nothing answers on, even when SMTP signed in fine, and saves nothing', async () => {
    const email = `no-imap-${Date.now()}@acme.com`;
    const imapPort = await closedPort();
    const smtpDials = accepting.connections();
    const response = await create(
      smtpMailbox(email, accepting.port, { imapHost: '127.0.0.1', imapPort }),
    );

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe(
      `We couldn't connect to 127.0.0.1 on port ${imapPort}. Check the IMAP host and port — most mail servers use 993.`,
    );
    expect(response.body).not.toMatch(TECHNICAL);
    expect(accepting.connections()).toBe(smtpDials + 1);
    expect(await prisma.mailbox.findUnique({ where: { email } })).toBeNull();
  });

  it('checks IMAP on its own when only an IMAP host is given', async () => {
    const email = `imap-only-${Date.now()}@acme.com`;
    const imapPort = await closedPort();
    const response = await create({
      email,
      imapHost: '127.0.0.1',
      imapPort,
      authUsername: email,
      authPassword: 'typed-password',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('Check the IMAP host and port');
    expect(await prisma.mailbox.findUnique({ where: { email } })).toBeNull();
  });

  it('reports the SMTP refusal when both servers fail', async () => {
    const email = `both-bad-${Date.now()}@acme.com`;
    const imapPort = await closedPort();
    const response = await create(
      smtpMailbox(email, rejecting.port, { imapHost: '127.0.0.1', imapPort }),
    );

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: SIGN_IN_REJECTED });
    expect(await prisma.mailbox.findUnique({ where: { email } })).toBeNull();
  });

  it('says "already connected" for a second try without dialing the server again', async () => {
    const email = `twice-${Date.now()}@acme.com`;
    const first = await create(smtpMailbox(email, accepting.port));
    expect(first.statusCode).toBe(201);
    createdMailboxIds.push(first.json().id);

    const dialsBefore = rejecting.connections();
    // The second try's password would be refused — the duplicate answer must come first.
    const second = await create(smtpMailbox(email.toUpperCase(), rejecting.port));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'This mailbox is already connected.' });
    expect(rejecting.connections()).toBe(dialsBefore);
  });

  it('does not dial anything for a mailbox without a password or without any mail host', async () => {
    const dialsBefore = accepting.connections() + rejecting.connections();

    const bare = await create({ email: `bare-${Date.now()}@acme.com` });
    expect(bare.statusCode).toBe(201);
    createdMailboxIds.push(bare.json().id);

    const oauthStub = await create({
      email: `oauth-${Date.now()}@acme.com`,
      provider: 'GOOGLE_WORKSPACE',
      smtpHost: '127.0.0.1',
      smtpPort: rejecting.port,
    });
    expect(oauthStub.statusCode).toBe(201);
    createdMailboxIds.push(oauthStub.json().id);

    const noHost = await create({
      email: `no-host-${Date.now()}@acme.com`,
      authUsername: 'u',
      authPassword: 'p',
    });
    expect(noHost.statusCode).toBe(201);
    createdMailboxIds.push(noHost.json().id);

    expect(accepting.connections() + rejecting.connections()).toBe(dialsBefore);
  });

  it('saves a mailbox on a reserved test host without dialing it', async () => {
    const email = `synthetic-${Date.now()}@wh-synth.example`;
    const response = await create({
      email,
      smtpHost: 'smtp.wh-synth.example',
      smtpPort: 587,
      imapHost: 'imap.wh-synth.example',
      imapPort: 993,
      authUsername: email,
      authPassword: 'not-a-real-password',
    });
    expect(response.statusCode).toBe(201);
    createdMailboxIds.push(response.json().id);
  });
});
