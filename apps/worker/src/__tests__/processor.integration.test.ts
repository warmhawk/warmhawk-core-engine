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
 * `QUEUED` — this suite asserts it now reverts to `UNTOUCHED` and the job throws instead.
 *
 * NOT run by `npm test` (unit config) — wired into `npm run test:integration`
 * (vitest.integration.config.ts). Skipped automatically if DATABASE_URL isn't set.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '@warmhawk/db';
import { processDispatchJob } from '../processor';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

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

    const domain = await prisma.domain.create({ data: { domainName: 'processor-test.example' } });
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
  });

  afterAll(async () => {
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

  it('reverts the lead to UNTOUCHED and throws when n8n answers 200 with a failed-status body', async () => {
    const lead = await createQueuedLead('failed-200@processor-test.example');
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { status: 'failed', leadId: lead.id, error: 'CAN-SPAM compliance error' }),
    );

    await expect(processDispatchJob({ leadId: lead.id, mailboxId })).rejects.toThrow(
      /failed send/i,
    );

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.status).toBe('UNTOUCHED');
    expect(updated.queuedJobId).toBeNull();
    expect(updated.queuedSlotAt).toBeNull();
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

  it('reverts the lead to UNTOUCHED and throws on a genuine non-2xx from the webhook call', async () => {
    const lead = await createQueuedLead('http-error@processor-test.example');
    fetchSpy.mockResolvedValue(jsonResponse(502, { error: 'Bad Gateway' }));

    await expect(processDispatchJob({ leadId: lead.id, mailboxId })).rejects.toThrow(/502/);

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.status).toBe('UNTOUCHED');
    expect(updated.queuedJobId).toBeNull();
  });

  it('does not clobber a lead that recordSendFailure already reclassified as BOUNCED', async () => {
    // Simulates the soft/hard-failure paths `sendMail`'s own catch block already handles: by the
    // time this function's `fetch` call returns, `recordSendFailure` has already updated the lead
    // (e.g. to BOUNCED for a hard bounce) server-side, inside the same request. Reproduced here by
    // updating the lead to BOUNCED before invoking processDispatchJob's failure branch — the
    // reversion check must be a no-op for a lead that isn't `QUEUED` any more.
    const lead = await createQueuedLead('hard-bounce@processor-test.example');
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'BOUNCED' } });

    fetchSpy.mockResolvedValue(
      jsonResponse(200, { status: 'failed', leadId: lead.id, error: 'user unknown' }),
    );

    await expect(processDispatchJob({ leadId: lead.id, mailboxId })).rejects.toThrow(/failed send/i);

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.status).toBe('BOUNCED'); // untouched — recordSendFailure already had the final say
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

    await expect(processDispatchJob({ leadId: lead.id, mailboxId })).rejects.toThrow(/failed send/i);

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated.status).toBe('QUEUED');
    expect(updated.retryCount).toBe(1); // unchanged by this function
    expect(updated.nextRetryAt).not.toBeNull(); // recordSendFailure's backoff schedule preserved
  });
});
