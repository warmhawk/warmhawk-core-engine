/**
 * Integration test for `GET /internal/mailboxes/active` against a REAL Postgres
 * (docker-compose.test.yml). This route is `requireCallbackSecret`-guarded (n8n's reply-poll
 * workflow, not a dashboard JWT caller) — mirrors `seedPlacement.integration.test.ts`'s setup
 * (real Prisma fixtures, `app.inject()`, self-skips without DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';

describeIntegration('/internal/mailboxes routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let domainId: string;
  let activeMailboxId: string;
  let pausedMailboxId: string;

  beforeAll(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = CALLBACK_SECRET;
    app = await createApp();
    await app.ready();

    const domain = await prisma.domain.create({
      data: { domainName: `internal-mailboxes-test-${Date.now()}.example.com` },
    });
    domainId = domain.id;

    const activeMailbox = await prisma.mailbox.create({
      data: { email: `active-${Date.now()}@example.com`, domainId, status: 'ACTIVE' },
    });
    activeMailboxId = activeMailbox.id;

    const pausedMailbox = await prisma.mailbox.create({
      data: { email: `paused-${Date.now()}@example.com`, domainId, status: 'PAUSED' },
    });
    pausedMailboxId = pausedMailbox.id;
  });

  afterAll(async () => {
    await prisma.mailbox.deleteMany({ where: { id: { in: [activeMailboxId, pausedMailboxId] } } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  it('lists only non-PAUSED mailboxes, surfacing just id and email', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/mailboxes/active',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    const found = json.mailboxes.find((m: { id: string }) => m.id === activeMailboxId);
    expect(found).toBeTruthy();
    expect(Object.keys(found).sort()).toEqual(['email', 'id']);
    expect(json.mailboxes.find((m: { id: string }) => m.id === pausedMailboxId)).toBeUndefined();
  });

  it('rejects a request with no callback secret', async () => {
    const response = await app.inject({ method: 'GET', url: '/internal/mailboxes/active' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a request with the wrong callback secret', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/mailboxes/active',
      headers: { 'x-callback-secret': 'wrong-secret' },
    });
    expect(response.statusCode).toBe(401);
  });
});
