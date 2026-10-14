/**
 * Regression guard for `GET /internal/replies/pending` (`routes/internalReplies.ts`): this exact
 * route silently returned zero candidates for every real send once `lib/mailSender.ts`'s privacy
 * fix stopped persisting `payloadSent.subject` — the route kept reading a field that no longer
 * existed, and no test caught it because route-level behavior here was previously untested.
 * Prisma is spied on the shared `@warmhawk/db` singleton rather than mock-replacing the whole
 * module, so every other route's `Prisma`/enum imports stay real and untouched.
 *
 * The existing-reply check was rewritten from a `reply.findFirst` per candidate lead (a sequential
 * N+1 — on a mailbox with thousands of CONTACTED leads, this workflow's every-few-minutes poll did
 * thousands of sequential DB round-trips) to a single batched `reply.findMany({ leadId: { in } })`
 * — see the fix's comment in the route file. Tests below mock `reply.findMany`, not `findFirst`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { createApp } from '../../app';
import * as mailSender from '../../lib/mailSender';

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
    const replyFindManySpy = vi.spyOn(prisma.reply, 'findMany').mockResolvedValue([] as never);

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
          providerMessageIds: ['<abc123@warmhawk>'],
          providerMessageId: '<abc123@warmhawk>',
        },
      ],
    });
    // One batched existence check for every candidate lead, not one round-trip per lead.
    expect(replyFindManySpy).toHaveBeenCalledTimes(1);
    expect(replyFindManySpy).toHaveBeenCalledWith({
      where: { leadId: { in: ['lead-1'] } },
      select: { leadId: true },
    });
  });

  it('regression: skips a log with no providerMessageId instead of surfacing an empty search term', async () => {
    vi.spyOn(prisma.executionLog, 'findMany').mockResolvedValue([
      baseLog({ providerMessageId: null }),
    ] as never);
    const replyFindManySpy = vi.spyOn(prisma.reply, 'findMany');

    const response = await app.inject({
      method: 'GET',
      url: '/internal/replies/pending?mailboxId=mb-1',
      headers: { 'x-callback-secret': 'test-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pending: [] });
    // No candidates survived the in-memory filters, so the batched existence check is skipped
    // entirely rather than querying with an empty `leadId: { in: [] }`.
    expect(replyFindManySpy).not.toHaveBeenCalled();
  });

  it('skips a lead that already has a Reply row', async () => {
    vi.spyOn(prisma.executionLog, 'findMany').mockResolvedValue([baseLog()] as never);
    vi.spyOn(prisma.reply, 'findMany').mockResolvedValue([{ leadId: 'lead-1' }] as never);

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
    const replyFindManySpy = vi.spyOn(prisma.reply, 'findMany');

    const response = await app.inject({
      method: 'GET',
      url: '/internal/replies/pending?mailboxId=mb-1',
      headers: { 'x-callback-secret': 'test-secret' },
    });

    expect(response.json()).toEqual({ pending: [] });
    expect(replyFindManySpy).not.toHaveBeenCalled();
  });

  it("returns every Message-ID in a lead's thread, oldest first, so a reply to a follow-up counts", async () => {
    // executionLog.findMany is ordered `createdAt: 'asc'` in the route: first email, then each
    // follow-up.
    vi.spyOn(prisma.executionLog, 'findMany').mockResolvedValue([
      baseLog({ providerMessageId: '<first@warmhawk>' }),
      baseLog({ providerMessageId: '<follow-up-1@warmhawk>' }),
    ] as never);
    vi.spyOn(prisma.reply, 'findMany').mockResolvedValue([] as never);

    const response = await app.inject({
      method: 'GET',
      url: '/internal/replies/pending?mailboxId=mb-1',
      headers: { 'x-callback-secret': 'test-secret' },
    });

    const body = response.json() as {
      pending: { providerMessageId: string; providerMessageIds: string[] }[];
    };
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]!.providerMessageIds).toEqual([
      '<first@warmhawk>',
      '<follow-up-1@warmhawk>',
    ]);
    expect(body.pending[0]!.providerMessageId).toBe('<first@warmhawk> <follow-up-1@warmhawk>');
  });

  it('batches the existence check across multiple candidate leads in a single query', async () => {
    vi.spyOn(prisma.executionLog, 'findMany').mockResolvedValue([
      baseLog({
        leadId: 'lead-1',
        providerMessageId: '<a@warmhawk>',
        lead: { status: 'CONTACTED', email: 'a@example.com' },
      }),
      baseLog({
        leadId: 'lead-2',
        providerMessageId: '<b@warmhawk>',
        lead: { status: 'CONTACTED', email: 'b@example.com' },
      }),
    ] as never);
    const replyFindManySpy = vi
      .spyOn(prisma.reply, 'findMany')
      .mockResolvedValue([{ leadId: 'lead-2' }] as never); // lead-2 already replied

    const response = await app.inject({
      method: 'GET',
      url: '/internal/replies/pending?mailboxId=mb-1',
      headers: { 'x-callback-secret': 'test-secret' },
    });

    expect(replyFindManySpy).toHaveBeenCalledTimes(1);
    expect(replyFindManySpy).toHaveBeenCalledWith({
      where: { leadId: { in: ['lead-1', 'lead-2'] } },
      select: { leadId: true },
    });
    const body = response.json() as { pending: { leadId: string }[] };
    expect(body.pending.map((p) => p.leadId)).toEqual(['lead-1']);
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

vi.mock('../../lib/mailSender', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/mailSender')>('../../lib/mailSender');
  return { ...actual, applyBounceCircuitBreaker: vi.fn() };
});

describe('POST /internal/replies', () => {
  let app: FastifyInstance;
  const originalSecret = process.env.NEXTJS_CALLBACK_SECRET;

  beforeEach(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = 'test-secret';
    vi.mocked(mailSender.applyBounceCircuitBreaker).mockResolvedValue(undefined);
    app = await createApp();
  });

  afterEach(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = originalSecret;
    vi.restoreAllMocks();
    vi.mocked(mailSender.applyBounceCircuitBreaker).mockClear();
    await app.close();
  });

  const body = {
    leadId: 'lead-1',
    campaignId: 'campaign-1',
    mailboxId: 'mb-1',
    rawContent: 'Sounds good, send details.',
    repliedAt: '2026-10-14T04:37:08.000Z',
  };
  const bounce = { status: '5.1.1', diagnostic: '550 5.1.1 User unknown' };

  function post(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/internal/replies',
      headers: { 'x-callback-secret': 'test-secret' },
      payload,
    });
  }

  it('stores a reply and ends the sequence as REPLIED', async () => {
    const createSpy = vi.spyOn(prisma.reply, 'create').mockResolvedValue({ id: 'r1' } as never);
    const leadSpy = vi.spyOn(prisma.lead, 'updateMany').mockResolvedValue({ count: 1 } as never);
    const logSpy = vi.spyOn(prisma.executionLog, 'update');

    const response = await post(body);

    expect(response.statusCode).toBe(201);
    expect(createSpy.mock.calls[0]![0].data).not.toHaveProperty('classification');
    expect(leadSpy).toHaveBeenCalledWith({
      where: { id: 'lead-1', status: { in: ['CONTACTED', 'OPENED', 'QUEUED'] } },
      data: { status: 'REPLIED', nextStepAt: null, nextRetryAt: null },
    });
    expect(logSpy).not.toHaveBeenCalled();
    expect(mailSender.applyBounceCircuitBreaker).not.toHaveBeenCalled();
  });

  it('records a delivery-failure report as a bounce: BOUNCED label, lead and send', async () => {
    const createSpy = vi.spyOn(prisma.reply, 'create').mockResolvedValue({ id: 'r1' } as never);
    const leadSpy = vi.spyOn(prisma.lead, 'updateMany').mockResolvedValue({ count: 1 } as never);
    vi.spyOn(prisma.executionLog, 'findFirst').mockResolvedValue({ id: 'log-2' } as never);
    const logSpy = vi.spyOn(prisma.executionLog, 'update').mockResolvedValue({} as never);

    const response = await post({ ...body, rawContent: '** Address not found **', bounce });

    expect(response.statusCode).toBe(201);
    expect(createSpy.mock.calls[0]![0].data).toMatchObject({
      classification: 'BOUNCED',
      classifiedAt: expect.any(Date),
    });
    expect(leadSpy.mock.calls[0]![0]).toMatchObject({ data: { status: 'BOUNCED' } });
    expect(logSpy).toHaveBeenCalledWith({
      where: { id: 'log-2' },
      data: {
        status: 'BOUNCED',
        errorMessage: 'The mail server returned this email (5.1.1): 550 5.1.1 User unknown',
      },
    });
    expect(mailSender.applyBounceCircuitBreaker).toHaveBeenCalledWith({
      campaignId: 'campaign-1',
      mailboxId: 'mb-1',
    });
  });

  it('a bounce for a lead that already answered or left the sequence changes nothing else', async () => {
    vi.spyOn(prisma.reply, 'create').mockResolvedValue({ id: 'r1' } as never);
    vi.spyOn(prisma.lead, 'updateMany').mockResolvedValue({ count: 0 } as never);
    const findSpy = vi.spyOn(prisma.executionLog, 'findFirst');

    const response = await post({ ...body, bounce });

    expect(response.statusCode).toBe(201);
    expect(findSpy).not.toHaveBeenCalled();
    expect(mailSender.applyBounceCircuitBreaker).not.toHaveBeenCalled();
  });

  it('a bounce report with no readable text stores its status line instead', async () => {
    const createSpy = vi.spyOn(prisma.reply, 'create').mockResolvedValue({ id: 'r1' } as never);
    vi.spyOn(prisma.lead, 'updateMany').mockResolvedValue({ count: 0 } as never);

    const response = await post({ ...body, rawContent: '', bounce });

    expect(response.statusCode).toBe(201);
    expect(createSpy.mock.calls[0]![0].data.rawContent).toContain('(5.1.1)');
  });

  it('422s on an empty reply that is not a bounce', async () => {
    const response = await post({ ...body, rawContent: '' });
    expect(response.statusCode).toBe(422);
  });
});
