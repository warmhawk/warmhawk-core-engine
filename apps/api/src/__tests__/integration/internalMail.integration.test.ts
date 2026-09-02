/**
 * Integration test for `POST /internal/mail/send` against a REAL Postgres (docker-compose.test.yml)
 * and a REAL SMTP peer — a minimal hand-rolled SMTP server (below), not a mock of
 * `nodemailer`/`mailSender.ts`. This repo's own Mailpit SMTP catcher
 * (`docker-compose.e2e-install.yml`) is deliberately NOT reused here — its header comment scopes
 * it to the separate install-flow e2e test only ("never used by docker-compose.test.yml's
 * integration-test flow"). Instead, this file opens a plain TCP server on an OS-assigned loopback
 * port speaking just enough of the RFC 5321 dialogue (EHLO/AUTH PLAIN/MAIL FROM/RCPT TO/DATA) for
 * nodemailer's real `SMTPTransport` to complete an actual send — so `sendMail()`'s real code path
 * (credential decryption, CAN-SPAM gate, RFC 8058 headers, EU AI disclosure, Lead/ExecutionLog
 * writes) runs entirely unmodified, end to end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { encrypt, loadEncryptionKey } from '../../lib/encryption';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';

interface FakeSmtpServer {
  port: number;
  close: () => Promise<void>;
}

function startFakeSmtpServer(): Promise<FakeSmtpServer> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      socket.write('220 fake-smtp.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          if (inData) {
            if (line === '.') {
              inData = false;
              socket.write('250 2.0.0 OK: queued as fake-message-id\r\n');
            }
            continue;
          }

          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250-fake-smtp.test\r\n250 AUTH PLAIN\r\n');
          } else if (upper.startsWith('AUTH PLAIN')) {
            socket.write('235 2.7.0 Authentication successful\r\n');
          } else if (upper.startsWith('MAIL FROM')) {
            socket.write('250 2.1.0 OK\r\n');
          } else if (upper.startsWith('RCPT TO')) {
            socket.write('250 2.1.5 OK\r\n');
          } else if (upper === 'DATA') {
            inData = true;
            socket.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
          } else if (upper.startsWith('QUIT')) {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else {
            socket.write('250 2.0.0 OK\r\n');
          }
        }
      });
      socket.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

describeIntegration('/internal/mail routes (integration, real Postgres + real SMTP peer)', () => {
  let app: FastifyInstance;
  let fakeSmtp: FakeSmtpServer;

  let domainId: string;
  let mailboxId: string;
  let mailboxEmail: string;
  let campaignId: string;
  let leadId: string;
  let leadEmail: string;

  beforeAll(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = CALLBACK_SECRET;
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('c'.repeat(32)).toString('base64');

    fakeSmtp = await startFakeSmtpServer();
    app = await createApp();
    await app.ready();

    await prisma.instanceSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', physicalMailingAddress: '123 Test St, Testville' },
      update: { physicalMailingAddress: '123 Test St, Testville' },
    });

    const domain = await prisma.domain.create({
      data: { domainName: `internal-mail-test-${Date.now()}.example.com` },
    });
    domainId = domain.id;

    mailboxEmail = `internal-mail-sender-${Date.now()}@example.com`;
    const key = loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY);
    const mailbox = await prisma.mailbox.create({
      data: {
        email: mailboxEmail,
        domainId,
        smtpHost: '127.0.0.1',
        smtpPort: fakeSmtp.port,
        authUsername: 'test-smtp-user',
        authPasswordEncrypted: encrypt('dummy-smtp-password', key),
      },
    });
    mailboxId = mailbox.id;

    const campaign = await prisma.campaign.create({
      data: {
        name: 'Internal Mail Send Test Campaign',
        status: 'ACTIVE',
        aiPromptTemplate: '',
        unsubscribeUrlTemplate: 'https://example.org/unsub?email={{email}}',
      },
    });
    campaignId = campaign.id;

    leadEmail = `internal-mail-lead-${Date.now()}@example.com`;
    const lead = await prisma.lead.create({
      data: { campaignId, email: leadEmail, status: 'UNTOUCHED' },
    });
    leadId = lead.id;
  });

  afterAll(async () => {
    await prisma.executionLog.deleteMany({ where: { campaignId } });
    await prisma.lead.deleteMany({ where: { campaignId } });
    await prisma.campaign.deleteMany({ where: { id: campaignId } });
    await prisma.mailbox.deleteMany({ where: { id: mailboxId } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await prisma.instanceSettings.deleteMany({ where: { id: 'default' } });
    await fakeSmtp.close();
    await app.close();
    await prisma.$disconnect();
  });

  it('sends a real, non-campaign email end-to-end over a real SMTP connection', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/mail/send',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { mailboxId, to: 'someone@example.org', subject: 'Hello', body: 'Hi there' },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.status).toBe('sent');
    expect(json.messageId).toBeTruthy();
    expect(json.euAiDisclosureAppended).toBe(false);
    expect(json.seedBccCount).toBe(0);
    // Non-campaign send: no CAN-SPAM headers attached.
    expect(json.listUnsubscribeHeader).toBeUndefined();
  });

  it('sends a real campaign email end-to-end: RFC 8058 headers attached, lead marked CONTACTED, ExecutionLog SENT recorded', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/mail/send',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: {
        mailboxId,
        to: leadEmail,
        subject: 'Campaign Subject',
        body: 'Campaign body',
        campaignId,
        leadId,
        n8nExecutionId: 'test-exec-1',
      },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.status).toBe('sent');
    expect(json.listUnsubscribeHeader).toBe(
      `<https://example.org/unsub?email=${encodeURIComponent(leadEmail)}>`,
    );
    expect(json.listUnsubscribePostHeader).toBe('List-Unsubscribe=One-Click');

    const updatedLead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(updatedLead.status).toBe('CONTACTED');

    const log = await prisma.executionLog.findFirst({ where: { leadId, status: 'SENT' } });
    expect(log).toBeTruthy();
    expect(log?.providerMessageId).toBeTruthy();
    expect(log?.n8nExecutionId).toBe('test-exec-1');
    // Privacy fix (Guardrails): only length metadata is persisted, never the actual content.
    expect(log?.payloadSent).toEqual({ subjectLength: 'Campaign Subject'.length, bodyLength: 'Campaign body'.length });

    const updatedMailbox = await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
    expect(updatedMailbox.sentToday).toBeGreaterThanOrEqual(1);
  });

  it('refuses a campaign send missing CAN-SPAM compliance (no unsubscribe template)', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'No Unsubscribe Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    const lead = await prisma.lead.create({
      data: { campaignId: campaign.id, email: `no-unsub-${Date.now()}@example.com`, status: 'UNTOUCHED' },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/mail/send',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: {
          mailboxId,
          to: lead.email,
          subject: 'x',
          body: 'y',
          campaignId: campaign.id,
          leadId: lead.id,
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/unsubscribe/i);
    } finally {
      await prisma.lead.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.campaign.deleteMany({ where: { id: campaign.id } });
    }
  });

  it('returns 404 for a nonexistent mailbox and 422 for missing required fields', async () => {
    const notFound = await app.inject({
      method: 'POST',
      url: '/internal/mail/send',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { mailboxId: 'does-not-exist', to: 'a@example.org', subject: 'x', body: 'y' },
    });
    expect(notFound.statusCode).toBe(404);

    const missingFields = await app.inject({
      method: 'POST',
      url: '/internal/mail/send',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: {},
    });
    expect(missingFields.statusCode).toBe(422);
  });

  it('returns 502 for a mailbox missing SMTP credentials', async () => {
    const bareMailbox = await prisma.mailbox.create({
      data: { email: `no-smtp-${Date.now()}@example.com`, domainId },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/mail/send',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: { mailboxId: bareMailbox.id, to: 'a@example.org', subject: 'x', body: 'y' },
      });
      expect(response.statusCode).toBe(502);
    } finally {
      await prisma.mailbox.deleteMany({ where: { id: bareMailbox.id } });
    }
  });

  it('rejects without a callback secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/mail/send',
      payload: { mailboxId, to: 'a@example.org', subject: 'x', body: 'y' },
    });
    expect(response.statusCode).toBe(401);
  });
});
