/**
 * `routes/replies.ts`: each reply in `GET /v1/replies` carries `sentAt`, when the email it answers
 * went out, looked up from the sends to that lead in one batched query; `GET /waiting-count` and
 * `PATCH /:id { handled }` back the dashboard's count of replies waiting on the user.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { createApp } from '../../app';

describe('/v1/replies', () => {
  let app: FastifyInstance;
  const originalToken = process.env.OPERATOR_SERVICE_TOKEN;
  const auth = { authorization: 'Bearer test-operator-token' };

  beforeEach(async () => {
    process.env.OPERATOR_SERVICE_TOKEN = 'test-operator-token';
    app = await createApp();
  });

  afterEach(async () => {
    process.env.OPERATOR_SERVICE_TOKEN = originalToken;
    vi.restoreAllMocks();
    await app.close();
  });

  const at = (iso: string) => new Date(iso);

  function replyRow(id: string, leadId: string, mailboxId: string, repliedAt: string) {
    return { id, leadId, mailboxId, campaignId: 'c-1', repliedAt: at(repliedAt) };
  }

  it('picks the latest send from the same mailbox at or before the reply', async () => {
    vi.spyOn(prisma.reply, 'findMany').mockResolvedValue([
      replyRow('r-1', 'lead-1', 'mb-1', '2026-10-10T12:00:00Z'),
      replyRow('r-2', 'lead-2', 'mb-1', '2026-10-10T12:00:00Z'),
    ] as never);
    vi.spyOn(prisma.reply, 'count').mockResolvedValue(2);
    // Newest first, as the route asks for.
    const sends = vi.spyOn(prisma.executionLog, 'findMany').mockResolvedValue([
      { leadId: 'lead-1', mailboxId: 'mb-1', createdAt: at('2026-10-11T09:00:00Z') }, // after reply
      { leadId: 'lead-1', mailboxId: 'mb-2', createdAt: at('2026-10-09T09:00:00Z') }, // other mailbox
      { leadId: 'lead-1', mailboxId: 'mb-1', createdAt: at('2026-10-08T09:00:00Z') },
      { leadId: 'lead-1', mailboxId: 'mb-1', createdAt: at('2026-10-01T09:00:00Z') },
    ] as never);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/replies?page=1&pageSize=25',
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(2);
    expect(
      body.replies.map((r: { id: string; sentAt: string | null }) => [r.id, r.sentAt]),
    ).toEqual([
      ['r-1', '2026-10-08T09:00:00.000Z'],
      ['r-2', null],
    ]);
    expect(sends).toHaveBeenCalledTimes(1);
    expect(sends.mock.calls[0]![0]).toMatchObject({
      where: { leadId: { in: ['lead-1', 'lead-2'] }, providerMessageId: { not: null } },
    });
  });

  it('adds sentAt to the unpaged list too, and skips the lookup when there are no replies', async () => {
    vi.spyOn(prisma.reply, 'findMany').mockResolvedValue([] as never);
    const sends = vi.spyOn(prisma.executionLog, 'findMany');

    const response = await app.inject({ method: 'GET', url: '/v1/replies', headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(sends).not.toHaveBeenCalled();
  });

  it('counts only interested and unsorted replies nobody has marked handled', async () => {
    const count = vi.spyOn(prisma.reply, 'count').mockResolvedValue(4);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/replies/waiting-count',
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ count: 4 });
    expect(count).toHaveBeenCalledWith({
      where: { classification: { in: ['INTERESTED', 'UNCLASSIFIED'] }, handledAt: null },
    });
  });

  it('marks a reply handled, and back', async () => {
    const update = vi.spyOn(prisma.reply, 'update').mockResolvedValue({ id: 'r-1' } as never);

    const done = await app.inject({
      method: 'PATCH',
      url: '/v1/replies/r-1',
      headers: auth,
      payload: { handled: true },
    });
    expect(done.statusCode).toBe(200);
    expect(update.mock.calls[0]![0]).toEqual({
      where: { id: 'r-1' },
      data: { handledAt: expect.any(Date) },
    });

    await app.inject({
      method: 'PATCH',
      url: '/v1/replies/r-1',
      headers: auth,
      payload: { handled: false },
    });
    expect(update.mock.calls[1]![0]).toEqual({ where: { id: 'r-1' }, data: { handledAt: null } });
  });

  it('refuses a patch with nothing to change', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/replies/r-1',
      headers: auth,
      payload: {},
    });
    expect(response.statusCode).toBe(422);
  });
});
