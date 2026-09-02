/**
 * Integration test for `/internal/imap` (`GET /search`, `POST /flag`, `POST /fetch-reply`)
 * against a REAL Postgres (docker-compose.test.yml). `requireCallbackSecret`-guarded, n8n-only.
 *
 * No real IMAP server exists in this test environment (and this repo's own docker-compose
 * overlays don't provide one for the integration-test flow — only Mailpit's SMTP catcher for a
 * separate install-flow e2e test, not IMAP). So the "success" path exercised here is the
 * furthest real one reachable without live IMAP: a genuine `Mailbox` row loaded from the real
 * database, correctly failing at the IMAP-connection-details validation step in
 * `lib/imapClient.ts#openImapClient` (distinct from, and a stronger signal than, a "mailbox id
 * doesn't exist at all" 404-shaped case) — proving the route wires the callback-secret guard,
 * request validation, and real Prisma lookup together correctly end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';

describeIntegration('/internal/imap routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let domainId: string;
  let mailboxNoImapId: string;

  beforeAll(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = CALLBACK_SECRET;
    app = await createApp();
    await app.ready();

    const domain = await prisma.domain.create({
      data: { domainName: `imap-test-${Date.now()}.example.com` },
    });
    domainId = domain.id;

    // Deliberately created with NO imapHost/imapPort/authUsername — a real row that should fail
    // cleanly with a specific "missing IMAP connection details" error, not "mailbox not found".
    const mailbox = await prisma.mailbox.create({
      data: { email: `no-imap-${Date.now()}@example.com`, domainId },
    });
    mailboxNoImapId = mailbox.id;
  });

  afterAll(async () => {
    await prisma.mailbox.deleteMany({ where: { id: mailboxNoImapId } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  describe('GET /search', () => {
    it('rejects without a callback secret', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/imap/search?mailboxId=${mailboxNoImapId}&providerMessageId=<abc@x>`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('validates required query params', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/imap/search',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
      });
      expect(response.statusCode).toBe(422);
    });

    it('loads the real mailbox row and fails cleanly on missing IMAP configuration', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/imap/search?mailboxId=${mailboxNoImapId}&providerMessageId=<abc@x>`,
        headers: { 'x-callback-secret': CALLBACK_SECRET },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toMatch(/missing IMAP connection details/i);
    });

    it('surfaces a distinct error for a mailboxId that does not exist at all', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/imap/search?mailboxId=does-not-exist&providerMessageId=<abc@x>',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toMatch(/mailbox not found/i);
    });
  });

  describe('POST /flag', () => {
    it('rejects without a callback secret', async () => {
      const response = await app.inject({ method: 'POST', url: '/internal/imap/flag', payload: {} });
      expect(response.statusCode).toBe(401);
    });

    it('validates required body fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/imap/flag',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: { mailboxId: mailboxNoImapId },
      });
      expect(response.statusCode).toBe(422);
    });

    it('rejects a malformed messageId before ever reaching IMAP', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/imap/flag',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: { mailboxId: mailboxNoImapId, messageId: 'not-a-valid-message-id', flags: ['\\Seen'] },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toMatch(/malformed messageid/i);
    });
  });

  describe('POST /fetch-reply', () => {
    it('rejects without a callback secret', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/imap/fetch-reply',
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });

    it('validates required body fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/imap/fetch-reply',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: {},
      });
      expect(response.statusCode).toBe(422);
    });

    it('loads the real mailbox row and fails cleanly on missing IMAP configuration', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/imap/fetch-reply',
        headers: { 'x-callback-secret': CALLBACK_SECRET },
        payload: { mailboxId: mailboxNoImapId, messageId: 'INBOX::1' },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toMatch(/missing IMAP connection details/i);
    });
  });
});
