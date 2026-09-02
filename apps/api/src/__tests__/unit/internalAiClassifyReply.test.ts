/**
 * Regression guard for `POST /internal/ai/classify-reply` (`routes/internalAi.ts`) — previously
 * untested at the route level (only the extracted `personalizeWithFallback` helper had coverage).
 * The one behavior most worth pinning down here is the OPT_OUT auto-suppression guardrail: a
 * classification of OPT_OUT must both create/upsert a SuppressionEntry and flip the lead to
 * SUPPRESSED, and — since the fix in this same file's header comment — do both inside a single
 * `prisma.$transaction` rather than as two independent awaits, so a mid-request failure can't
 * leave a SuppressionEntry without the matching lead status (or vice versa).
 *
 * `classifyReply` (aiProviderClient) and `decrypt` (encryption) are mocked; `safeCompare` and
 * `loadEncryptionKey` stay real so the callback-secret guard and key-format validation are
 * exercised as written, matching the pattern in internalReplies.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { createApp } from '../../app';
import * as aiProviderClient from '../../lib/aiProviderClient';
import * as encryption from '../../lib/encryption';

vi.mock('../../lib/aiProviderClient', async () => {
  const actual = await vi.importActual<typeof aiProviderClient>('../../lib/aiProviderClient');
  return { ...actual, classifyReply: vi.fn() };
});

vi.mock('../../lib/encryption', async () => {
  const actual = await vi.importActual<typeof encryption>('../../lib/encryption');
  return { ...actual, decrypt: vi.fn().mockReturnValue('decrypted-api-key') };
});

const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

describe('POST /internal/ai/classify-reply', () => {
  let app: FastifyInstance;
  const originalSecret = process.env.NEXTJS_CALLBACK_SECRET;
  const originalKey = process.env.MAILBOX_CREDENTIAL_KEY;

  beforeEach(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = 'test-secret';
    process.env.MAILBOX_CREDENTIAL_KEY = VALID_KEY;
    app = await createApp();
  });

  afterEach(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = originalSecret;
    process.env.MAILBOX_CREDENTIAL_KEY = originalKey;
    vi.restoreAllMocks();
    await app.close();
  });

  function classifyReplyRequest(body: Record<string, unknown> = { replyId: 'reply-1' }) {
    return app.inject({
      method: 'POST',
      url: '/internal/ai/classify-reply',
      headers: { 'x-callback-secret': 'test-secret' },
      payload: body,
    });
  }

  const baseReplyRow = {
    id: 'reply-1',
    leadId: 'lead-1',
    rawContent: 'Please stop emailing me',
    campaign: { aiProvider: 'GEMINI' },
  };

  it('classifies a reply and persists the classification, with no suppression side effect', async () => {
    vi.spyOn(prisma.reply, 'findUnique').mockResolvedValue(baseReplyRow as never);
    vi.spyOn(prisma.aiProviderKey, 'findUnique').mockResolvedValue({
      provider: 'GEMINI',
      apiKeyEncrypted: 'irrelevant',
      model: 'gemini-2.5-flash',
      isActive: true,
    } as never);
    vi.mocked(aiProviderClient.classifyReply).mockResolvedValue({ classification: 'INTERESTED' });
    const updateSpy = vi
      .spyOn(prisma.reply, 'update')
      .mockResolvedValue({ ...baseReplyRow, classification: 'INTERESTED' } as never);
    const transactionSpy = vi.spyOn(prisma, '$transaction');

    const response = await classifyReplyRequest();

    expect(response.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: 'reply-1' },
      data: { classification: 'INTERESTED', classifiedAt: expect.any(Date) },
    });
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('OPT_OUT: upserts a SuppressionEntry and flips the lead to SUPPRESSED inside one transaction', async () => {
    vi.spyOn(prisma.reply, 'findUnique').mockResolvedValue(baseReplyRow as never);
    vi.spyOn(prisma.aiProviderKey, 'findUnique').mockResolvedValue({
      provider: 'GEMINI',
      apiKeyEncrypted: 'irrelevant',
      model: 'gemini-2.5-flash',
      isActive: true,
    } as never);
    vi.mocked(aiProviderClient.classifyReply).mockResolvedValue({ classification: 'OPT_OUT' });
    vi.spyOn(prisma.reply, 'update').mockResolvedValue({ ...baseReplyRow, classification: 'OPT_OUT' } as never);
    vi.spyOn(prisma.lead, 'findUnique').mockResolvedValue({ id: 'lead-1', email: 'lead1@example.com' } as never);
    const upsertSpy = vi.spyOn(prisma.suppressionEntry, 'upsert').mockResolvedValue({} as never);
    const leadUpdateSpy = vi.spyOn(prisma.lead, 'update').mockResolvedValue({} as never);
    const transactionSpy = vi.spyOn(prisma, '$transaction').mockImplementation(async (ops) => {
      return Promise.all(ops as unknown as Promise<unknown>[]);
    });

    const response = await classifyReplyRequest();

    expect(response.statusCode).toBe(200);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    // Both writes happen as part of the SAME transaction call (one array of two operations),
    // not as two independent, separately-awaited calls — that's the atomicity fix itself.
    expect(transactionSpy.mock.calls[0]![0]).toHaveLength(2);
    expect(upsertSpy).toHaveBeenCalledWith({
      where: { email: 'lead1@example.com' },
      create: {
        email: 'lead1@example.com',
        reason: 'Reply opt-out language detected',
        source: 'reply_opt_out',
      },
      update: {},
    });
    expect(leadUpdateSpy).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { status: 'SUPPRESSED' } });
  });

  it('OPT_OUT but the lead is already gone: skips the transaction instead of crashing', async () => {
    vi.spyOn(prisma.reply, 'findUnique').mockResolvedValue(baseReplyRow as never);
    vi.spyOn(prisma.aiProviderKey, 'findUnique').mockResolvedValue({
      provider: 'GEMINI',
      apiKeyEncrypted: 'irrelevant',
      model: 'gemini-2.5-flash',
      isActive: true,
    } as never);
    vi.mocked(aiProviderClient.classifyReply).mockResolvedValue({ classification: 'OPT_OUT' });
    vi.spyOn(prisma.reply, 'update').mockResolvedValue({ ...baseReplyRow, classification: 'OPT_OUT' } as never);
    vi.spyOn(prisma.lead, 'findUnique').mockResolvedValue(null as never);
    const transactionSpy = vi.spyOn(prisma, '$transaction');

    const response = await classifyReplyRequest();

    expect(response.statusCode).toBe(200);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('with no AI provider configured anywhere, classifies as UNCLASSIFIED without calling the provider', async () => {
    vi.spyOn(prisma.reply, 'findUnique').mockResolvedValue({
      ...baseReplyRow,
      campaign: { aiProvider: null },
    } as never);
    vi.spyOn(prisma.aiProviderKey, 'findFirst').mockResolvedValue(null as never);
    const updateSpy = vi
      .spyOn(prisma.reply, 'update')
      .mockResolvedValue({ ...baseReplyRow, classification: 'UNCLASSIFIED' } as never);

    const response = await classifyReplyRequest();

    expect(response.statusCode).toBe(200);
    expect(aiProviderClient.classifyReply).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: 'reply-1' },
      data: { classification: 'UNCLASSIFIED', classifiedAt: expect.any(Date) },
    });
  });

  it('404s when the reply does not exist', async () => {
    vi.spyOn(prisma.reply, 'findUnique').mockResolvedValue(null as never);
    const response = await classifyReplyRequest();
    expect(response.statusCode).toBe(404);
  });

  it('422s when replyId is missing', async () => {
    const response = await classifyReplyRequest({});
    expect(response.statusCode).toBe(422);
  });

  it('rejects a request without a valid callback secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/ai/classify-reply',
      headers: { 'x-callback-secret': 'wrong-secret' },
      payload: { replyId: 'reply-1' },
    });
    expect(response.statusCode).toBe(401);
  });
});
