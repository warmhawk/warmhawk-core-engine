import { beforeEach, describe, expect, it, vi } from 'vitest';

const count = vi.fn();
const mailboxUpdate = vi.fn();
const campaignUpdate = vi.fn();

vi.mock('@warmhawk/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@warmhawk/db')>()),
  prisma: {
    executionLog: { count: (args: unknown) => count(args) },
    mailbox: { update: (args: unknown) => (mailboxUpdate(args), Promise.resolve({})) },
    campaign: {
      findUnique: () => Promise.resolve({ pausedForBounceRate: false, bounceRateThreshold: 0.05 }),
      update: (args: unknown) => (campaignUpdate(args), Promise.resolve({})),
    },
  },
}));

import { applyBounceCircuitBreaker } from '../../lib/mailSender';

/** The mailbox's last 7 days: `sends` (every send, bounced ones included) and `bounces`. The
 *  campaign's all-time counts stay clean so only the mailbox breaker is in play. */
function mailboxWeek(sends: number, bounces: number) {
  count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (!('mailboxId' in where)) return where.status === 'BOUNCED' ? 0 : 500;
    return where.status === 'BOUNCED' ? bounces : sends;
  });
}

describe('mailbox bounce pause', () => {
  beforeEach(() => {
    count.mockReset();
    mailboxUpdate.mockReset();
    campaignUpdate.mockReset();
  });

  it('counts only the last 7 days, and every kind of send', async () => {
    mailboxWeek(60, 0);
    const before = Date.now();
    await applyBounceCircuitBreaker({ campaignId: 'c1', mailboxId: 'm1' });
    const sendsQuery = count.mock.calls
      .map(([args]) => args.where)
      .find((where) => where.mailboxId && where.status !== 'BOUNCED');
    expect(sendsQuery.status).toEqual({ in: ['SENT', 'OPENED', 'REPLIED', 'BOUNCED'] });
    const since = (sendsQuery.createdAt as { gt: Date }).gt.getTime();
    // Seven days before the call, give or take the few ms the call took.
    expect(Math.abs(before - 7 * 24 * 3600_000 - since)).toBeLessThan(5_000);
  });

  it('pauses a mailbox over 3% bounces in its last 7 days', async () => {
    mailboxWeek(60, 2); // 3.3%
    await applyBounceCircuitBreaker({ campaignId: 'c1', mailboxId: 'm1' });
    expect(mailboxUpdate).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({ status: 'PAUSED', autoFlaggedAt: expect.any(Date) }),
    });
  });

  it('keeps sending at or under 3%', async () => {
    mailboxWeek(100, 3);
    await applyBounceCircuitBreaker({ campaignId: 'c1', mailboxId: 'm1' });
    expect(mailboxUpdate.mock.calls[0][0].data).toEqual({ rollingBounceRate: 0.03 });
  });

  it('waits for 50 sends before judging a mailbox', async () => {
    mailboxWeek(40, 3); // 7.5%, but too few sends to tell
    await applyBounceCircuitBreaker({ campaignId: 'c1', mailboxId: 'm1' });
    expect(mailboxUpdate.mock.calls[0][0].data.status).toBeUndefined();
  });
});
