/**
 * Integration test for `POST /internal/ai/personalize` against a REAL Postgres
 * (docker-compose.test.yml) — covers the bug this route actually shipped with: the no-provider and
 * inactive-key fallback branches returned `campaign.template` completely unprocessed (neither
 * `{{firstName}}`/`{{company}}` merge fields nor `{opt1|opt2}` spintax groups resolved). Confirmed
 * live in a real send (see notes/warmhawk/quickstart-video/README.md's bug writeup) before this fix
 * — `renderFallbackTemplate()` in routes/internalAi.ts now runs merge fields then spintax on both
 * fallback branches. Mirrors internalMail.integration.test.ts's setup style (real Prisma fixtures,
 * `x-callback-secret` header, `app.inject()`, self-skips without DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';

const TEMPLATE = 'Hi {{firstName}}, {Quick question|One thing I noticed} about {{company}} — got a minute?';

describeIntegration('/internal/ai/personalize (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let campaignIds: string[] = [];
  let leadIds: string[] = [];

  beforeAll(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = CALLBACK_SECRET;
    app = await createApp();
    await app.ready();
  });

  afterEach(async () => {
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.aiProviderKey.deleteMany({ where: { provider: 'GEMINI' } });
    campaignIds = [];
    leadIds = [];
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('no AI provider configured ("Skip for now"): renders merge fields AND resolves spintax, instead of returning the raw template', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Skip-AI Personalize Test', aiPromptTemplate: '', template: TEMPLATE },
    });
    campaignIds.push(campaign.id);
    const lead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        email: `personalize-lead-${Date.now()}@example.com`,
        firstName: 'Ada',
        company: 'Acme Corp',
      },
    });
    leadIds.push(lead.id);

    const response = await app.inject({
      method: 'POST',
      url: '/internal/ai/personalize',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { campaignId: campaign.id, leadId: lead.id },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.aiUsed).toBe(false);

    // Merge fields resolved — no raw {{...}} left anywhere.
    expect(json.generatedText).toContain('Hi Ada,');
    expect(json.generatedText).toContain('about Acme Corp');
    expect(json.generatedText).not.toMatch(/\{\{.*\}\}/);

    // Spintax resolved to exactly one of its two options — no raw {a|b} group, and no literal
    // "firstName"/pipe-delimited text left over (the exact regression this bug produced when
    // spintax and merge fields collided — see renderFallbackTemplate's own comment).
    expect(json.generatedText).not.toMatch(/\{[^{}]*\|[^{}]*\}/);
    const gotOptionA = json.generatedText.includes('Quick question about');
    const gotOptionB = json.generatedText.includes('One thing I noticed about');
    expect(gotOptionA || gotOptionB).toBe(true);
    expect(gotOptionA && gotOptionB).toBe(false);
  });

  it('AI provider configured but the key is inactive: same merge-field + spintax rendering, not the raw template', async () => {
    await prisma.aiProviderKey.create({
      data: { provider: 'GEMINI', apiKeyEncrypted: 'unused-in-this-test', model: 'gemini-2.5-flash', isActive: false },
    });
    const campaign = await prisma.campaign.create({
      data: { name: 'Inactive-Key Personalize Test', aiPromptTemplate: '', template: TEMPLATE, aiProvider: 'GEMINI' },
    });
    campaignIds.push(campaign.id);
    const lead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        email: `personalize-lead-inactive-${Date.now()}@example.com`,
        firstName: 'Grace',
        company: 'Hopper Labs',
      },
    });
    leadIds.push(lead.id);

    const response = await app.inject({
      method: 'POST',
      url: '/internal/ai/personalize',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { campaignId: campaign.id, leadId: lead.id },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.aiUsed).toBe(false);
    expect(json.generatedText).toContain('Hi Grace,');
    expect(json.generatedText).toContain('about Hopper Labs');
    expect(json.generatedText).not.toMatch(/\{\{.*\}\}/);
    expect(json.generatedText).not.toMatch(/\{[^{}]*\|[^{}]*\}/);
  });

  it('falls back to campaign.aiPromptTemplate (rendered, not raw) when template is null', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'No-Template Fallback Test', aiPromptTemplate: 'Hey {{firstName}}, {short note|quick note}.' },
    });
    campaignIds.push(campaign.id);
    const lead = await prisma.lead.create({
      data: { campaignId: campaign.id, email: `personalize-lead-notpl-${Date.now()}@example.com`, firstName: 'Lin' },
    });
    leadIds.push(lead.id);

    const response = await app.inject({
      method: 'POST',
      url: '/internal/ai/personalize',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload: { campaignId: campaign.id, leadId: lead.id },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.generatedText).toContain('Hey Lin,');
    expect(json.generatedText).not.toMatch(/\{\{.*\}\}/);
    expect(json.generatedText).not.toMatch(/\{[^{}]*\|[^{}]*\}/);
  });

  it('rejects without a callback secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/ai/personalize',
      payload: { campaignId: 'does-not-matter', leadId: 'does-not-matter' },
    });
    expect(response.statusCode).toBe(401);
  });
});
