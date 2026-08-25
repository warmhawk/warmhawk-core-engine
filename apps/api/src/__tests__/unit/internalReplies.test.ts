/**
 * Regression guard for `GET /internal/replies/pending` (`routes/internalReplies.ts`): this exact
 * route silently returned zero candidates for every real send once `lib/mailSender.ts`'s privacy
 * fix stopped persisting `payloadSent.subject` — the route kept reading a field that no longer
 * existed, and no test caught it because route-level behavior here was previously untested.
 * Prisma is spied on the shared `@warmhawk/db` singleton rather than mock-replacing the whole
 * module, so every other route's `Prisma`/enum imports stay real and untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { createApp } from '../../app';

describe('GET /internal/replies/pending', () => {
  let app: FastifyInstance;
  const originalSecret = process.env.NEXTJS_CALLBACK_SECRET;

  beforeEach(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = 'test-secret';
    app = await createApp();
  });

  afterEach(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = originalSecret;
    vi.restoreAllMocks();
    await app.close();
  });

  function baseLog(overrides: Record<string, unknown> = {}) {
    return {
      leadId: 'lead-1',
      campaignId: 'campaign-1',
      providerMessageId: '<abc123@warmhawk>',
      lead: { status: 'CONTACTED', email: 'lead1@example.com' },
      ...overrides,
    };
  }

  it('surfaces providerMessageId for a CONTACTED lead with no existing reply', async () => {
    vi.spyOn(prisma.executionLog, 'findMany').mockResolvedValue([baseLog()] as never);
    vi.spyOn(prisma.reply, 'findFirst').mockResolvedValue(null as never);

    const response = await app.inject({
      method: 'GET',
      url: '/internal/replies/pending?mailboxId=mb-1',
      headers: { 'x-callback-secret': 'test-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      pending: [
        {
          leadId: 'lead-1',
          campaignId: 'campaign-1',
          email: 'lead1@example.com',
          providerMessageId: '<abc123@warmhawk>',
        },
      ],
    });
  });

  it('regression: skips a log with no providerMessageId instead of surfacing an empty search term', async () => {
    vi.spyOn(prisma.executionLog, 'findMany').mockResolvedValue([
      baseLog({ providerMessageId: null }),
    ] as never);
    vi.spyOn(prisma.reply, 'findFirst').mockResolvedValue(null as never);

    const response = await app.inject({
      method: 'GET',
      url: '/internal/replies/pending?mailboxId=mb-1',
      headers: { 'x-callback-secret': 'test-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pending: [] });
  });

  it('skips a lead that already has a Reply row', async () => {
    vi.spyOn(prisma.executionLog, 'findMany').mockResolvedValue([baseLog()] as never);
    vi.spyOn(prisma.reply, 'findFirst').mockResolvedValue({ id: 'reply-1' } as never);

    const response = await app.inject({
      method: 'GET',
      url: '/internal/replies/pending?mailboxId=mb-1',
      headers: { 'x-callback-secret': 'test-secret' },
    });

    expect(response.json()).toEqual({ pending: [] });
  });

  it('skips a lead that is no longer CONTACTED (already replied/bounced/suppressed)', async () => {
    vi.spyOn(prisma.executionLog, 'findMany').mockResolvedValue([
      baseLog({ lead: { status: 'BOUNCED', email: 'lead1@example.com' } }),
    ] as never);
    vi.spyOn(prisma.reply, 'findFirst').mockResolvedValue(null as never);

    const response = await app.inject({
      method: 'GET',
      url: '/internal/replies/pending?mailboxId=mb-1',
      headers: { 'x-callback-secret': 'test-secret' },
    });

    expect(response.json()).toEqual({ pending: [] });
  });

  it('rejects a request without a valid callback secret', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/replies/pending?mailboxId=mb-1',
      headers: { 'x-callback-secret': 'wrong-secret' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('is unreachable under the public /v1 prefix', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/replies/pending?mailboxId=mb-1',
      headers: { 'x-callback-secret': 'test-secret' },
    });

    expect(response.statusCode).toBe(404);
  });
});
