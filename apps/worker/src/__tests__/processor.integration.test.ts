/**
 * Integration test for `processDispatchJob` — requires a real Postgres (docker-compose.test.yml),
 * same pattern as `reconcile.integration.test.ts`: real `Lead`/`Campaign` rows, `global.fetch`
 * stubbed to stand in for n8n's dispatch webhook (see `n8n/workflows/dispatch.json`) so this
 * covers the actual Prisma reads/writes without needing a live n8n workflow import.
 *
 * Bug fix regression guard (silent lead loss, 2026-09-04) — see the header comment on the
 * `dispatchFailed` block in `../processor.ts` for the full story. The case that matters most here
 * is the 200-with-`{status:"failed"}` response: before the fix, `processDispatchJob` only checked
 * `response.ok` (true for that response), so it returned normally and left the Lead exactly as
 * `QUEUED` with its job id — this suite asserts it now frees the lead for a backed-off retry
 * (`nextRetryAt`) and the job throws instead.
 *
 * NOT run by `npm test` (unit config) — wired into `npm run test:integration`
 * (vitest.integration.config.ts). Skipped automatically if DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import IORedis from 'ioredis';
import { prisma } from '@warmhawk/db';
import { checkAddress } from '../addressCheck';
import { processDispatchJob, setReservationRedis } from '../processor';
import { mailboxReservationKey } from '../queue';

// The address check's SMTP conversation is covered in addressCheck.test.ts; here only its verdict
// matters. Off (ADDRESS_CHECK_HELO unset) for every case but the one that sets it.
vi.mock('../addressCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../addressCheck')>()),
  checkAddress: vi.fn(),
}));

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const itWithRedis = process.env.REDIS_URL ? it : it.skip;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describeIntegration('processDispatchJob (integration, real Postgres)', () => {
  let campaignId: string;
  let mailboxId: string;
  const fetchSpy = vi.fn();

  beforeAll(async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Processor Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;

    // A first email only goes from a domain with a mailing address, through a mailbox the
    // campaign sends from — so the domain has one and the mailbox is ticked below.
    const domain = await prisma.domain.create({
      data: { domainName: 'processor-test.example', mailingAddress: '1 Test Street, Springfield' },
    });
    const mailbox = await prisma.mailbox.create({
      data: {
        domainId: domain.id,
        email: 'sender@processor-test.example',
        provider: 'SMTP_CUSTOM',
        status: 'ACTIVE',
        dailyCap: 100,
        sentToday: 0,
      },
    });
    mailboxId = mailbox.id;
    await prisma.campaignMailbox.create({ data: { campaignId, mailboxId } });
  });

  afterAll(async () => {
    await prisma.executionLog.deleteMany({ where: { campaignId } });
    await prisma.lead.deleteMany({ where: { campaignId } });
    await prisma.mailbox.delete({ where: { id: mailboxId } }).catch(() => undefined);
    await prisma.domain.deleteMany({ where: { domainName: 'processor-test.example' } });
    await prisma.campaign.delete({ where: { id: campaignId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.lead.deleteMany({ where: { campaignId } });
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  async function createQueuedLead(email: string) {
    const jobId = `${email}:${mailboxId}:${Date.now()}`;
    return prisma.lead.create({
      data: {
        campaignId,
        email,
        status: 'QUEUED',
        queuedJobId: jobId,
        queuedSlotAt: new Date(),
      },
    });
  }

  it('backs the lead off for a retry and throws when n8n answers 200 with a failed-status body', async () => {
    const lead = await createQueuedLead('failed-200@processor-test.example');
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { status: 'failed', leadId: lead.id, error: 'CAN-SPAM compliance error' }),
    );

    await expect(processDispatchJob({ leadId: lead.id, mailboxId })).rejects.toThrow(
      /failed send/i,
    );

    // Back in the queue, but not re-picked on the next tick: it waits out DISPATCH_FAILURE_RETRY_MS.
    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.status).toBe('QUEUED');
    expect(updated.queuedJobId).toBeNull();
    expect(updated.queuedSlotAt).toBeNull();
    expect(updated.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves the lead alone when n8n answers 200 with a sent-status body (real success)', async () => {
    const lead = await createQueuedLead('sent-200@processor-test.example');
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { status: 'sent', leadId: lead.id, messageId: '<abc@example.test>' }),
    );

    await expect(processDispatchJob({ leadId: lead.id, mailboxId })).resolves.toBeUndefined();

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    // Real success is recorded server-side by `/internal/mail/send` itself (CONTACTED) — this
    // function must not touch a lead it correctly identified as sent.
    expect(updated.status).toBe('QUEUED');
    expect(updated.queuedJobId).not.toBeNull();
  });

  it('backs the lead off for a retry and throws on a genuine non-2xx from the webhook call', async () => {
    const lead = await createQueuedLead('http-error@processor-test.example');
    fetchSpy.mockResolvedValue(jsonResponse(502, { error: 'Bad Gateway' }));

    await expect(processDispatchJob({ leadId: lead.id, mailboxId })).rejects.toThrow(/502/);

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.status).toBe('QUEUED');
    expect(updated.queuedJobId).toBeNull();
    expect(updated.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not clobber a lead that recordSendFailure already reclassified as BOUNCED', async () => {
    // Simulates the soft/hard-failure paths `sendMail`'s own catch block already handles: by the
    // time this function's `fetch` call returns, `recordSendFailure` has already updated the lead
    // (e.g. to BOUNCED for a hard bounce) server-side, inside the same request. Reproduced here by
    // updating the lead to BOUNCED inside the stubbed webhook call — the reversion check must be a
    // no-op for a lead that isn't `QUEUED` any more.
    const lead = await createQueuedLead('hard-bounce@processor-test.example');

    fetchSpy.mockImplementation(async () => {
      await prisma.lead.update({ where: { id: lead.id }, data: { status: 'BOUNCED' } });
      return jsonResponse(200, { status: 'failed', leadId: lead.id, error: 'user unknown' });
    });

    await expect(processDispatchJob({ leadId: lead.id, mailboxId })).rejects.toThrow(
      /failed send/i,
    );

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.status).toBe('BOUNCED'); // untouched — recordSendFailure already had the final say
  });

  it('stops a dead address before n8n is called, as FAILED with the reason logged', async () => {
    vi.stubEnv('ADDRESS_CHECK_HELO', 'check.processor-test.example');
    vi.mocked(checkAddress).mockResolvedValue({
      verdict: 'invalid',
      detail:
        "the recipient's mail server says this address doesn't exist (550 5.1.1 no such user)",
    });
    try {
      const lead = await createQueuedLead('dead@processor-test.example');

      await expect(processDispatchJob({ leadId: lead.id, mailboxId })).resolves.toBeUndefined();

      expect(fetchSpy).not.toHaveBeenCalled();
      const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(updated.status).toBe('FAILED');
      expect(updated.queuedJobId).toBeNull();
      const logs = await prisma.executionLog.findMany({ where: { leadId: lead.id } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ status: 'FAILED', mailboxId });
      expect(logs[0].errorMessage).toMatch(/^Not sent: .*5\.1\.1.*nothing went out\.$/);
    } finally {
      vi.unstubAllEnvs();
      vi.mocked(checkAddress).mockReset();
    }
  });

  itWithRedis('hands a dead address’s slot back, but keeps a booking made since', async () => {
    const redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    setReservationRedis(redis);
    vi.stubEnv('ADDRESS_CHECK_HELO', 'check.processor-test.example');
    vi.mocked(checkAddress).mockResolvedValue({ verdict: 'invalid', detail: '550 5.1.1' });
    const key = mailboxReservationKey(mailboxId);
    try {
      const dead = await createQueuedLead('dead-slot@processor-test.example');
      await redis.set(key, String(dead.queuedSlotAt!.getTime()), 'EX', 600);
      await processDispatchJob({ leadId: dead.id, mailboxId });
      expect(await redis.get(key)).toBeNull();

      // The enqueuer booked the mailbox's next slot while this one was being checked.
      const raced = await createQueuedLead('dead-raced@processor-test.example');
      const nextSlot = String(raced.queuedSlotAt!.getTime() + 300_000);
      await redis.set(key, nextSlot, 'EX', 600);
      await processDispatchJob({ leadId: raced.id, mailboxId });
      expect(await redis.get(key)).toBe(nextSlot);
    } finally {
      await redis.del(key);
      setReservationRedis(null);
      await redis.quit();
      vi.unstubAllEnvs();
      vi.mocked(checkAddress).mockReset();
    }
  });

  it('sends as before when the check can’t tell', async () => {
    vi.stubEnv('ADDRESS_CHECK_HELO', 'check.processor-test.example');
    vi.mocked(checkAddress).mockResolvedValue({ verdict: 'unknown', detail: 'greylisted' });
    try {
      const lead = await createQueuedLead('maybe@processor-test.example');
      fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'sent', leadId: lead.id }));

      await expect(processDispatchJob({ leadId: lead.id, mailboxId })).resolves.toBeUndefined();

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(checkAddress).toHaveBeenCalledWith('maybe@processor-test.example', expect.anything());
    } finally {
      vi.unstubAllEnvs();
      vi.mocked(checkAddress).mockReset();
    }
  });

  it('does not clobber a lead recordSendFailure already rescheduled with a real nextRetryAt', async () => {
    // Same idea for the soft-failure-not-exhausted path: recordSendFailure sets status back to
    // QUEUED but with queuedJobId cleared and a real future nextRetryAt — this function's
    // `queuedJobId` check must tell that apart from "never touched" and leave it alone.
    const lead = await createQueuedLead('soft-retry@processor-test.example');
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        status: 'QUEUED',
        queuedJobId: null,
        queuedSlotAt: null,
        retryCount: 1,
        nextRetryAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });

    fetchSpy.mockResolvedValue(
      jsonResponse(200, { status: 'failed', leadId: lead.id, error: 'connection timed out' }),
    );

    await expect(processDispatchJob({ leadId: lead.id, mailboxId })).rejects.toThrow(
      /failed send/i,
    );

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.status).toBe('QUEUED');
    expect(updated.retryCount).toBe(1); // unchanged by this function
    expect(updated.nextRetryAt).not.toBeNull(); // recordSendFailure's backoff schedule preserved
  });
});
