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
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { encrypt, loadEncryptionKey } from '../../lib/encryption';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;
const CALLBACK_SECRET = process.env.NEXTJS_CALLBACK_SECRET || 'test-only-callback-secret';

const TEMPLATE = 'Hi {{firstName}}, {Quick question|One thing I noticed} about {{company}} — got a minute?';

describeIntegration('/internal/ai/personalize (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let campaignIds: string[] = [];
  let leadIds: string[] = [];
  let domainIds: string[] = [];

  beforeAll(async () => {
    process.env.NEXTJS_CALLBACK_SECRET = CALLBACK_SECRET;
    process.env.MAILBOX_CREDENTIAL_KEY =
      process.env.MAILBOX_CREDENTIAL_KEY || Buffer.from('p'.repeat(32)).toString('base64');
    app = await createApp();
    await app.ready();
  });

  afterEach(async () => {
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.aiProviderKey.deleteMany({ where: { provider: 'GEMINI' } });
    await prisma.mailbox.deleteMany({ where: { domainId: { in: domainIds } } });
    await prisma.domain.deleteMany({ where: { id: { in: domainIds } } });
    vi.restoreAllMocks();
    campaignIds = [];
    leadIds = [];
    domainIds = [];
  });

  async function fixture(campaign: Parameters<typeof prisma.campaign.create>[0]['data']) {
    const created = await prisma.campaign.create({ data: campaign });
    campaignIds.push(created.id);
    const lead = await prisma.lead.create({
      data: {
        campaignId: created.id,
        email: `compose-lead-${Date.now()}-${Math.random()}@acme.example`,
        firstName: 'Dana',
        company: 'Acme Logistics',
        customFields: { title: 'Head of Ops' },
      },
    });
    leadIds.push(lead.id);
    return { campaign: created, lead };
  }

  async function mailbox(senderName: string | null) {
    const domain = await prisma.domain.create({ data: { domainName: `compose-${Date.now()}.example` } });
    domainIds.push(domain.id);
    return prisma.mailbox.create({
      data: { email: `sam.patel@${domain.domainName}`, domainId: domain.id, senderName },
    });
  }

  async function activeGeminiKey() {
    const key = loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
    await prisma.aiProviderKey.create({
      data: { provider: 'GEMINI', apiKeyEncrypted: encrypt('test-gemini-key', key), model: 'gemini-2.5-flash', isActive: true },
    });
  }

  /** Stubs the one outbound Gemini call; tests never reach a live endpoint. */
  function geminiReplies(...replies: Array<{ status: number; text?: string }>) {
    const spy = vi.spyOn(global, 'fetch');
    for (const r of replies) {
      spy.mockResolvedValueOnce(
        new Response(
          r.status === 200 ? JSON.stringify({ candidates: [{ content: { parts: [{ text: r.text }] } }] }) : 'error',
          { status: r.status },
        ),
      );
    }
    return spy;
  }

  async function personalize(payload: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/ai/personalize',
      headers: { 'x-callback-secret': CALLBACK_SECRET },
      payload,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it("uses the campaign's own subject, rendered, and reports TEMPLATE with no provider", async () => {
    const { campaign, lead } = await fixture({
      name: 'Subject Test',
      aiPromptTemplate: '',
      subject: '{Quick idea|An idea} for {{company}}',
      template: 'Hi {{firstName}},\n\nBody line.\n\n{{senderName}}',
    });
    const box = await mailbox('Sam Patel');

    const json = await personalize({ campaignId: campaign.id, leadId: lead.id, mailboxId: box.id });
    expect(json.subject).toMatch(/^(Quick idea|An idea) for Acme Logistics$/);
    expect(json.body).toBe('Hi Dana,\n\nBody line.\n\nSam Patel');
    expect(json.aiOutcome).toBe('TEMPLATE');
    expect(json.aiFallbackReason).toBeNull();
    // Old dispatch workflows split generatedText on its first newline — that must still land.
    expect(json.generatedText).toBe(`${json.subject}\n${json.body}`);
  });

  it('fills {{senderName}} from the address when the mailbox has no sender name', async () => {
    const { campaign, lead } = await fixture({
      name: 'Sender Fallback Test',
      aiPromptTemplate: '',
      subject: 'Hello',
      template: 'Hi {{firstName}}, — {{senderName}}',
    });
    const box = await mailbox(null);
    const json = await personalize({ campaignId: campaign.id, leadId: lead.id, mailboxId: box.id });
    expect(json.body).toBe('Hi Dana, — Sam');
  });

  it('an inactive key reports AI_FALLBACK with reason key_missing', async () => {
    await prisma.aiProviderKey.create({
      data: { provider: 'GEMINI', apiKeyEncrypted: 'unused', model: 'gemini-2.5-flash', isActive: false },
    });
    const { campaign, lead } = await fixture({
      name: 'Key Missing Test',
      aiPromptTemplate: '',
      subject: 'Hello',
      template: 'Hi {{firstName}}',
      aiProvider: 'GEMINI',
    });
    const json = await personalize({ campaignId: campaign.id, leadId: lead.id });
    expect(json.aiOutcome).toBe('AI_FALLBACK');
    expect(json.aiFallbackReason).toBe('key_missing');
    expect(json.aiPersonalizationFailed).toBe(true);
    expect(json.body).toBe('Hi Dana');
  });

  it('PERSONALIZE sends the rendered template to the model and keeps the campaign subject', async () => {
    await activeGeminiKey();
    const { campaign, lead } = await fixture({
      name: 'Personalize Mode Test',
      aiPromptTemplate: '',
      subject: 'Faster dispatch at {{company}}',
      template: 'Hi {{firstName}},\n\nWe cut dispatch time by 30%.',
      aiProvider: 'GEMINI',
      aiMode: 'PERSONALIZE',
    });
    const spy = geminiReplies({ status: 200, text: 'Hi Dana, running ops at Acme is no small job.\n\nWe cut dispatch time by 30%.' });

    const json = await personalize({ campaignId: campaign.id, leadId: lead.id });
    const prompt = JSON.parse(String(spy.mock.calls[0][1]?.body)).contents[0].parts[0].text as string;
    expect(prompt).toContain('<email>\nHi Dana,\n\nWe cut dispatch time by 30%.\n</email>');
    expect(json.aiOutcome).toBe('AI_WRITTEN');
    expect(json.subject).toBe('Faster dispatch at Acme Logistics');
    expect(json.body).toContain('running ops at Acme');
  });

  it('aiWritesSubject takes the model\'s Subject: line over the campaign subject', async () => {
    await activeGeminiKey();
    const { campaign, lead } = await fixture({
      name: 'AI Subject Test',
      aiPromptTemplate: 'Write a short intro.',
      subject: 'Campaign subject',
      template: 'Hi {{firstName}}',
      aiProvider: 'GEMINI',
      aiMode: 'PROMPT',
      aiWritesSubject: true,
    });
    geminiReplies({ status: 200, text: 'Subject: Dispatch at Acme\n\nHi Dana, short intro.' });

    const json = await personalize({ campaignId: campaign.id, leadId: lead.id });
    expect(json.subject).toBe('Dispatch at Acme');
    expect(json.body).toBe('Hi Dana, short intro.');
  });

  it('a retired model falls back to the template and says model_unavailable', async () => {
    await activeGeminiKey();
    const { campaign, lead } = await fixture({
      name: 'Model 404 Test',
      aiPromptTemplate: '',
      subject: 'Hello {{firstName}}',
      template: 'Plain template body',
      aiProvider: 'GEMINI',
    });
    geminiReplies({ status: 404 }, { status: 404 });

    const json = await personalize({ campaignId: campaign.id, leadId: lead.id });
    expect(json.aiOutcome).toBe('AI_FALLBACK');
    expect(json.aiFallbackReason).toBe('model_unavailable');
    expect(json.subject).toBe('Hello Dana');
    expect(json.body).toBe('Plain template body');
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
