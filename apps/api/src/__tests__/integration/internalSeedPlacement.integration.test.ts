/**
 * Integration test for `POST /internal/seed-placement/poll` against a REAL Postgres
 * (docker-compose.test.yml). Deliberately exercised in a state with zero *active* seed accounts
 * (true of the shared dev Postgres at the time this file was written — confirmed via a manual
 * count) so the poll tick's real aggregation logic (`lib/seedPlacementPoller.ts`) runs end-to-end
 * without needing a live IMAP server: with no active seed accounts, `pollSeedAccountFolder` (the
 * one function that would need real IMAP) is never called at all — a real, honest "nothing to
 * check yet" code path, not a mock. The `resultsRecorded === campaignsChecked * seedAccountsChecked`
 * invariant asserted below holds regardless of how many seed accounts happen to exist when this
 * runs, so it stays correct even if that precondition ever changes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';

describeIntegration('/internal/seed-placement routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let domainId: string;
  let mailboxId: string;
  let campaignId: string;
  let leadId: string;

  beforeAll(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = CALLBACK_SECRET;
    app = await createApp();
    await app.ready();

    const domain = await prisma.domain.create({
      data: { domainName: `seed-poll-test-${Date.now()}.example.com` },
    });
    domainId = domain.id;

    const mailbox = await prisma.mailbox.create({
      data: { email: `seed-poll-sender-${Date.now()}@example.com`, domainId },
    });
    mailboxId = mailbox.id;

    const campaign = await prisma.campaign.create({
      data: { name: 'Seed Placement Poll Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;

    const lead = await prisma.lead.create({
      data: { campaignId, email: `seed-poll-lead-${Date.now()}@example.com`, status: 'CONTACTED' },
    });
    leadId = lead.id;

    // A recent real send — inside the poll tick's default 24h lookback window.
    await prisma.executionLog.create({
      data: { campaignId, leadId, mailboxId, status: 'SENT' },
    });
  });

  afterAll(async () => {
    await prisma.seedPlacementResult.deleteMany({ where: { campaignId } });
    await prisma.executionLog.deleteMany({ where: { campaignId } });
    await prisma.lead.deleteMany({ where: { campaignId } });
    await prisma.campaign.deleteMany({ where: { id: campaignId } });
    await prisma.mailbox.deleteMany({ where: { id: mailboxId } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  it('runs a poll tick, counting the recent send and recording per (campaign, seed account) results', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/seed-placement/poll',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.campaignsChecked).toBeGreaterThanOrEqual(1);
    expect(json.seedAccountsChecked).toBeGreaterThanOrEqual(0);
    expect(json.resultsRecorded).toBe(json.campaignsChecked * json.seedAccountsChecked);
  }, 20_000);

  it('accepts an explicit lookbackHours override', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/seed-placement/poll',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { lookbackHours: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('campaignsChecked');
  }, 20_000);

  it('rejects a request with no callback secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/seed-placement/poll',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });
});
