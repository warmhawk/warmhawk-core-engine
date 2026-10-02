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
import { signUnsubscribeToken } from '../../lib/unsubscribeToken';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';

interface FakeSmtpServer {
  port: number;
  close: () => Promise<void>;
  /** Raw DATA of every message received, oldest first — for asserting on sent headers. */
  messages: string[];
}

function startFakeSmtpServer(): Promise<FakeSmtpServer> {
  const messages: string[] = [];
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let dataLines: string[] = [];
      socket.write('220 fake-smtp.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          if (inData) {
            if (line !== '.') dataLines.push(line);
            if (line === '.') {
              inData = false;
              messages.push(dataLines.join('\n'));
              dataLines = [];
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
      resolve({ port, messages, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

/** The text part of a raw message: nodemailer quoted-printable-encodes lines over 76 chars. */
function textOf(raw: string): string {
  const body = raw.slice(raw.indexOf('\n\n') + 2);
  return /quoted-printable/i.test(raw)
    ? body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    : body;
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
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
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
    // Non-campaign send: no CAN-SPAM headers attached, and no footer in the body.
    expect(json.listUnsubscribeHeader).toBeUndefined();
    expect(json.canSpamFooterAppended).toBe(false);
    expect(textOf(fakeSmtp.messages.at(-1) as string).trim()).toBe('Hi there');
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
    // The CAN-SPAM footer is part of what went out, so it counts toward the length.
    const sentBody = `Campaign body\n\n--\n123 Test St, Testville\nUnsubscribe: https://example.org/unsub?email=${encodeURIComponent(leadEmail)}`;
    expect(log?.payloadSent).toEqual({ subjectLength: 'Campaign Subject'.length, bodyLength: sentBody.length });
    expect(json.canSpamFooterAppended).toBe(true);
    expect(textOf(fakeSmtp.messages.at(-1) as string).trim()).toBe(sentBody);

    const updatedMailbox = await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
    expect(updatedMailbox.sentToday).toBeGreaterThanOrEqual(1);
  });

  it('sends From the mailbox sender name and records who wrote the copy on the ExecutionLog', async () => {
    await prisma.mailbox.update({ where: { id: mailboxId }, data: { senderName: 'Sam Patel' } });
    const lead = await prisma.lead.create({
      data: { campaignId, email: `ai-outcome-${Date.now()}@acme.example`, status: 'UNTOUCHED' },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/mail/send',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: {
          mailboxId,
          to: lead.email,
          subject: 'Outcome Subject',
          body: 'Outcome body',
          campaignId,
          leadId: lead.id,
          aiOutcome: 'AI_FALLBACK',
          aiFallbackReason: 'model_unavailable',
        },
      });
      expect(response.statusCode).toBe(200);

      const log = await prisma.executionLog.findFirstOrThrow({ where: { leadId: lead.id, status: 'SENT' } });
      expect(log.aiOutcome).toBe('AI_FALLBACK');
      expect(log.aiFallbackReason).toBe('model_unavailable');
      expect(fakeSmtp.messages.at(-1)).toMatch(new RegExp(`^From: "?Sam Patel"? <${mailboxEmail}>$`, 'm'));
    } finally {
      await prisma.mailbox.update({ where: { id: mailboxId }, data: { senderName: null } });
    }
  });

  it('adds the EU AI disclosure by the reported outcome, not by whether the campaign has a provider', async () => {
    const send = async (aiOutcome: string) => {
      const lead = await prisma.lead.create({
        data: { campaignId, email: `eu-${aiOutcome}-${Date.now()}@acme.example`, status: 'UNTOUCHED' },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/internal/mail/send',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: { mailboxId, to: lead.email, subject: 'EU', body: 'EU body', campaignId, leadId: lead.id, countryCode: 'DE', aiOutcome },
      });
      expect(response.statusCode).toBe(200);
      return response.json().euAiDisclosureAppended;
    };
    expect(await send('AI_WRITTEN')).toBe(true);
    expect(await send('AI_FALLBACK')).toBe(false);
    expect(await send('NOT_A_REAL_OUTCOME')).toBe(false);
  });

  it('does not repeat an address or unsubscribe link the email already carries', async () => {
    const lead = await prisma.lead.create({
      data: { campaignId, email: `footer-dedupe-${Date.now()}@acme.example`, status: 'UNTOUCHED' },
    });
    const unsubscribeUrl = `https://example.org/unsub?email=${encodeURIComponent(lead.email)}`;
    const send = (body: string, leadId: string, to: string) =>
      app.inject({
        method: 'POST',
        url: '/internal/mail/send',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: { mailboxId, to, subject: 'Dedupe', body, campaignId, leadId },
      });

    const signedOff = await send('Thanks,\nSam\n123 Test St,\nTestville', lead.id, lead.email);
    expect(signedOff.json().canSpamFooterAppended).toBe(true);
    const sent = textOf(fakeSmtp.messages.at(-1) as string);
    expect(sent.match(/123 Test St/g)).toHaveLength(1);
    expect(sent.trim().endsWith(`--\nUnsubscribe: ${unsubscribeUrl}`)).toBe(true);

    const lead2 = await prisma.lead.create({
      data: { campaignId, email: `footer-both-${Date.now()}@acme.example`, status: 'UNTOUCHED' },
    });
    const both = `Hi\n123 Test St, Testville\nOpt out: https://example.org/unsub?email=${encodeURIComponent(lead2.email)}`;
    const complete = await send(both, lead2.id, lead2.email);
    expect(complete.json().canSpamFooterAppended).toBe(false);
    expect(textOf(fakeSmtp.messages.at(-1) as string).trim()).toBe(both);
  });

  it('puts the footer after the EU AI disclosure on an AI-written EU send', async () => {
    const lead = await prisma.lead.create({
      data: { campaignId, email: `footer-eu-${Date.now()}@acme.de`, status: 'UNTOUCHED' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/mail/send',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { mailboxId, to: lead.email, subject: 'EU', body: 'Hallo', campaignId, leadId: lead.id, aiOutcome: 'AI_WRITTEN' },
    });
    expect(response.json()).toMatchObject({ euAiDisclosureAppended: true, canSpamFooterAppended: true });
    const sent = textOf(fakeSmtp.messages.at(-1) as string);
    expect(sent.indexOf('EU AI Act Article 50')).toBeLessThan(sent.indexOf('123 Test St'));
  });

  it('refuses a campaign send with no instance mailing address, and never reaches SMTP', async () => {
    const lead = await prisma.lead.create({
      data: { campaignId, email: `no-address-${Date.now()}@acme.example`, status: 'UNTOUCHED' },
    });
    const received = fakeSmtp.messages.length;
    await prisma.instanceSettings.delete({ where: { id: 'default' } });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/mail/send',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: { mailboxId, to: lead.email, subject: 'x', body: 'y', campaignId, leadId: lead.id },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatch(/physical mailing address/i);
      expect(fakeSmtp.messages.length).toBe(received);
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('UNTOUCHED');
    } finally {
      await prisma.instanceSettings.create({ data: { id: 'default', physicalMailingAddress: '123 Test St, Testville' } });
    }
  });

  it('links the built-in unsubscribe page when the campaign has no link of its own', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Built-in Unsubscribe Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    const lead = await prisma.lead.create({
      data: { campaignId: campaign.id, email: `built-in-unsub-${Date.now()}@example.com`, status: 'UNTOUCHED' },
    });
    const savedDomain = process.env.WARMHAWK_DOMAIN;
    process.env.WARMHAWK_DOMAIN = 'api.acme.example';

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/mail/send',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: { mailboxId, to: lead.email, subject: 'x', body: 'Hi', campaignId: campaign.id, leadId: lead.id },
      });
      expect(response.statusCode).toBe(200);

      const url = `https://api.acme.example/unsubscribe/${signUnsubscribeToken(lead.id)}`;
      expect(response.json().listUnsubscribeHeader).toBe(`<${url}>`);
      expect(response.json().listUnsubscribePostHeader).toBe('List-Unsubscribe=One-Click');
      expect(textOf(fakeSmtp.messages.at(-1) as string).trim()).toBe(
        `Hi\n\n--\n123 Test St, Testville\nUnsubscribe: ${url}`,
      );

      // The link that went out is a live one: following it takes the lead off the list.
      const clicked = await app.inject({ method: 'POST', url: new URL(url).pathname });
      expect(clicked.statusCode).toBe(200);
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('SUPPRESSED');
    } finally {
      if (savedDomain === undefined) delete process.env.WARMHAWK_DOMAIN;
      else process.env.WARMHAWK_DOMAIN = savedDomain;
      await prisma.suppressionEntry.deleteMany({ where: { email: lead.email } });
      await prisma.executionLog.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.lead.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.campaign.deleteMany({ where: { id: campaign.id } });
    }
  });

  it('refuses a campaign send to a suppressed address, never reaches SMTP, and takes the lead out of the queue', async () => {
    const lead = await prisma.lead.create({
      data: {
        campaignId,
        email: `opted-out-${Date.now()}@acme.example`,
        status: 'QUEUED',
        nextRetryAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.suppressionEntry.create({ data: { email: lead.email, source: 'unsubscribe_link' } });
    const received = fakeSmtp.messages.length;

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/mail/send',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: { mailboxId, to: lead.email, subject: 'x', body: 'y', campaignId, leadId: lead.id },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'ESUPPRESSED' });
      expect(fakeSmtp.messages.length).toBe(received);

      const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(after.status).toBe('SUPPRESSED');
      expect(after.nextRetryAt).toBeNull();
    } finally {
      await prisma.suppressionEntry.deleteMany({ where: { email: lead.email } });
    }
  });

  it('refuses a campaign send missing CAN-SPAM compliance (no unsubscribe template, no install domain)', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'No Unsubscribe Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    const lead = await prisma.lead.create({
      data: { campaignId: campaign.id, email: `no-unsub-${Date.now()}@example.com`, status: 'UNTOUCHED' },
    });
    const savedDomain = process.env.WARMHAWK_DOMAIN;
    delete process.env.WARMHAWK_DOMAIN;

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
      if (savedDomain !== undefined) process.env.WARMHAWK_DOMAIN = savedDomain;
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
