/**
 * Integration test for `syncCampaignCompletion` against a real Postgres: a Sending campaign turns
 * Completed once it owes no lead an email, and a Completed one goes back to Sending when it does.
 * Skipped without DATABASE_URL, like every integration test here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma, type CampaignStatus, type Prisma } from '@warmhawk/db';
import { syncCampaignCompletion } from '../campaignCompletion';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('syncCampaignCompletion (integration, real Postgres)', () => {
  let campaignId: string;
  let domainId: string;
  let mailboxId: string;

  const status = async () =>
    (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;
  const setStatus = (value: CampaignStatus) =>
    prisma.campaign.update({ where: { id: campaignId }, data: { status: value } });
  const addLead = (data: Omit<Prisma.LeadUncheckedCreateInput, 'campaignId' | 'email'> = {}) =>
    prisma.lead.create({
      data: {
        campaignId,
        email: `lead-${Math.random().toString(36).slice(2)}@example.com`,
        ...data,
      },
    });

  beforeAll(async () => {
    const domain = await prisma.domain.create({
      data: { domainName: 'completion-test.example', mailingAddress: '1 Test Street, Springfield' },
    });
    domainId = domain.id;
    const mailbox = await prisma.mailbox.create({
      data: {
        domainId,
        email: 'sender@completion-test.example',
        provider: 'SMTP_CUSTOM',
        status: 'ACTIVE',
        dailyCap: 100,
      },
    });
    mailboxId = mailbox.id;
    const campaign = await prisma.campaign.create({
      data: { name: 'Completion Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;
  });

  afterAll(async () => {
    await prisma.campaign.delete({ where: { id: campaignId } }).catch(() => undefined);
    await prisma.mailbox.delete({ where: { id: mailboxId } }).catch(() => undefined);
    await prisma.domain.delete({ where: { id: domainId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.lead.deleteMany({ where: { campaignId } });
    await setStatus('ACTIVE');
  });

  it('leaves a Sending campaign with no leads yet alone', async () => {
    await syncCampaignCompletion();
    expect(await status()).toBe('ACTIVE');
  });

  it('marks a campaign Completed once every lead is done', async () => {
    await addLead({ status: 'CONTACTED', stepsSent: 3, nextStepAt: null });
    await addLead({ status: 'REPLIED' });
    await addLead({ status: 'BOUNCED' });
    await addLead({ status: 'SUPPRESSED' });
    await addLead({ status: 'FAILED' });
    await syncCampaignCompletion();
    expect(await status()).toBe('COMPLETED');
  });

  it.each([
    ['a first email waiting', { status: 'UNTOUCHED' as const }],
    ['a first email queued', { status: 'QUEUED' as const }],
    [
      'a follow-up due later',
      { status: 'CONTACTED' as const, nextStepAt: new Date(Date.now() + 86_400_000) },
    ],
    ['a follow-up queued', { status: 'OPENED' as const, nextStepAt: null, queuedJobId: 'job-1' }],
  ])('keeps it Sending while %s', async (_label, lead) => {
    await addLead({ status: 'CONTACTED', nextStepAt: null });
    await addLead(lead);
    await syncCampaignCompletion();
    expect(await status()).toBe('ACTIVE');
  });

  it('does not wait on a follow-up for a lead that replied', async () => {
    const lead = await addLead({
      status: 'CONTACTED',
      mailboxId,
      nextStepAt: new Date(Date.now() + 86_400_000),
    });
    await prisma.reply.create({
      data: { leadId: lead.id, campaignId, mailboxId, rawContent: 'Thanks', repliedAt: new Date() },
    });
    await syncCampaignCompletion();
    expect(await status()).toBe('COMPLETED');
  });

  it('puts a Completed campaign back to Sending when it gets a new lead', async () => {
    await addLead({ status: 'CONTACTED', nextStepAt: null });
    await syncCampaignCompletion();
    expect(await status()).toBe('COMPLETED');

    await addLead();
    await syncCampaignCompletion();
    expect(await status()).toBe('ACTIVE');
  });

  it('never touches a Paused campaign', async () => {
    await addLead({ status: 'CONTACTED', nextStepAt: null });
    await setStatus('PAUSED');
    await syncCampaignCompletion();
    expect(await status()).toBe('PAUSED');
  });
});
