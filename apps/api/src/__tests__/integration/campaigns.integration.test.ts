/**
 * Integration test for `/v1/campaigns` (list w/ aggregates, `GET /:id`, `POST /`, `PATCH /:id`,
 * `POST /:id/launch`, `POST /:id/pause`, `DELETE /:id`) against a REAL Postgres
 * (docker-compose.test.yml). Mirrors `seedPlacement.integration.test.ts`'s fixture style.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';
import { signUnsubscribeToken } from '../../lib/unsubscribeToken';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

describeIntegration('campaigns routes (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;

  let domainId: string;
  let mailboxId: string;
  const createdCampaignIds: string[] = [];
  // What the sending domain prints in every footer — a launch needs it (address is per domain).
  const address = '100 Example Street, Springfield, ST 00000';
  /** Ticks the test mailbox as one of the campaign's senders — a launch needs at least one. */
  const linkSender = (campaignId: string) =>
    prisma.campaignMailbox.create({ data: { campaignId, mailboxId } });

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    app = await createApp();
    await app.ready();

    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.org', role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const domain = await prisma.domain.create({
      data: { domainName: `campaigns-test-${Date.now()}.example.com`, mailingAddress: address },
    });
    domainId = domain.id;

    const mailbox = await prisma.mailbox.create({
      data: {
        email: `campaigns-sender-${Date.now()}@example.com`,
        domainId,
        status: 'ACTIVE',
        senderName: 'Sam Sender',
      },
    });
    mailboxId = mailbox.id;
  });

  afterAll(async () => {
    await prisma.executionLog.deleteMany({ where: { campaignId: { in: createdCampaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: createdCampaignIds } } });
    await prisma.mailbox.deleteMany({ where: { id: mailboxId } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  it('creates a campaign with valid spintax content-quality metadata, and rejects a missing name / malformed spintax', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        name: 'Integration Test Campaign',
        aiPromptTemplate: '',
        template: 'Hi {there|friend}, quick question.',
      },
    });
    expect(created.statusCode).toBe(201);
    const json = created.json();
    createdCampaignIds.push(json.id);
    expect(json.contentQuality.spintaxGroupCount).toBe(1);
    expect(json.contentQuality.spamScore).toBeTruthy();

    const missingName = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { aiPromptTemplate: '' },
    });
    expect(missingName.statusCode).toBe(422);

    const badSpintax = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'Bad Spintax Campaign', aiPromptTemplate: '', template: '{unclosed|group' },
    });
    expect(badSpintax.statusCode).toBe(422);
  });

  it('lists campaigns with real send/reply/domain aggregates for one with actual activity', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Aggregates Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    createdCampaignIds.push(campaign.id);

    const lead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        email: `agg-lead-${Date.now()}@example.com`,
        status: 'CONTACTED',
      },
    });
    await prisma.executionLog.create({
      data: { campaignId: campaign.id, leadId: lead.id, mailboxId, status: 'SENT' },
    });
    await prisma.reply.create({
      data: {
        leadId: lead.id,
        campaignId: campaign.id,
        mailboxId,
        rawContent: 'thanks!',
        repliedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/campaigns',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(200);
    const found = response.json().find((c: { id: string }) => c.id === campaign.id);
    expect(found).toBeTruthy();
    expect(found.leadsCount).toBe(1);
    expect(found.repliesCount).toBe(1);
    expect(found.sentCount).toBe(1);
    expect(found.domainsCount).toBe(1);
    expect(found.lastActivityAt).not.toBeNull();
  });

  it('lists follow-ups sent per step and the follow-ups still coming', async () => {
    const campaign = await prisma.campaign.create({
      data: {
        name: 'Follow-up Columns',
        aiPromptTemplate: '',
        template: 'Hi',
        steps: {
          create: [
            { position: 1, waitDays: 3, body: 'Bumping this' },
            { position: 2, waitDays: 4, body: 'Last note' },
          ],
        },
      },
    });
    createdCampaignIds.push(campaign.id);
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const later = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const lead = (email: string, data: object) =>
      prisma.lead.create({ data: { campaignId: campaign.id, email, mailboxId, ...data } });
    // Got both follow-ups; got follow-up 1 and is due follow-up 2; due follow-up 1; replied.
    await lead('done@example.org', { status: 'CONTACTED', stepsSent: 3 });
    await lead('soon@example.org', { status: 'CONTACTED', stepsSent: 2, nextStepAt: soon });
    await lead('later@example.org', { status: 'CONTACTED', stepsSent: 1, nextStepAt: later });
    await lead('replied@example.org', { status: 'REPLIED', stepsSent: 1 });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/campaigns',
      headers: { authorization: `Bearer ${authToken}` },
    });
    const found = response.json().find((c: { id: string }) => c.id === campaign.id);
    expect(found.progress.followUpsSent).toEqual([2, 1]);
    expect(found.progress.followUpsDue).toBe(2);
    const upcoming = found.progress.upcomingFollowUps as Array<{
      position: number;
      at: string;
      count: number;
    }>;
    expect(upcoming.map(({ position, count }) => ({ position, count }))).toEqual([
      { position: 2, count: 1 },
      { position: 1, count: 1 },
    ]);
    // Floored to its 15-minute bucket.
    const at = new Date(upcoming[0].at).getTime();
    expect(at).toBeLessThanOrEqual(soon.getTime());
    expect(soon.getTime() - at).toBeLessThan(15 * 60 * 1000);
    expect(at % (15 * 60 * 1000)).toBe(0);

    await prisma.lead.deleteMany({ where: { campaignId: campaign.id } });
  });

  it('fetches a campaign by id and 404s an unknown id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/campaigns/${createdCampaignIds[0]}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(createdCampaignIds[0]);

    const notFound = await app.inject({
      method: 'GET',
      url: '/v1/campaigns/does-not-exist',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('patches a campaign template and re-evaluates content quality, and 404s an unknown id', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${createdCampaignIds[0]}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { template: 'Updated {copy|text} here' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().contentQuality.spintaxGroupCount).toBe(1);

    const notFound = await app.inject({
      method: 'PATCH',
      url: '/v1/campaigns/does-not-exist',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'x' },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('launches with no unsubscribe template of its own when the install has a domain for the built-in page', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Built-in Unsubscribe', aiPromptTemplate: '', template: 'Hi {{firstName}}' },
    });
    createdCampaignIds.push(campaign.id);
    await linkSender(campaign.id);
    const savedDomain = process.env.WARMHAWK_DOMAIN;
    process.env.WARMHAWK_DOMAIN = 'api.acme.example';
    try {
      const launched = await app.inject({
        method: 'POST',
        url: `/v1/campaigns/${campaign.id}/launch`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(launched.statusCode).toBe(200);
      expect(launched.json().status).toBe('ACTIVE');
    } finally {
      if (savedDomain === undefined) delete process.env.WARMHAWK_DOMAIN;
      else process.env.WARMHAWK_DOMAIN = savedDomain;
    }
  });

  it('refuses to launch without an unsubscribe template on an install with no domain, then launches once one is set; pause works and 404s unknown', async () => {
    const id = createdCampaignIds[0];
    delete process.env.WARMHAWK_DOMAIN;
    // Sender, domain address and copy are all in place, so the only thing missing is the link.
    await linkSender(id);

    const refused = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${id}/launch`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(refused.statusCode).toBe(422);

    await prisma.campaign.update({
      where: { id },
      data: { unsubscribeUrlTemplate: 'https://example.org/unsub?email={{email}}' },
    });

    const launched = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${id}/launch`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(launched.statusCode).toBe(200);
    expect(launched.json().status).toBe('ACTIVE');

    const paused = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${id}/pause`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().status).toBe('PAUSED');

    const notFound = await app.inject({
      method: 'POST',
      url: '/v1/campaigns/does-not-exist/pause',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('refuses to launch a campaign paused for an elevated bounce rate', async () => {
    const campaign = await prisma.campaign.create({
      data: {
        name: 'Bounce-Paused Campaign',
        aiPromptTemplate: '',
        unsubscribeUrlTemplate: 'https://example.org/unsub',
        pausedForBounceRate: true,
      },
    });
    createdCampaignIds.push(campaign.id);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${campaign.id}/launch`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(422);
  });

  it('archives a campaign via DELETE (soft-delete) and 404s deleting it again', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'To Be Archived', aiPromptTemplate: '' },
    });
    createdCampaignIds.push(campaign.id);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/campaigns/${campaign.id}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(deleted.statusCode).toBe(204);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('ARCHIVED');

    const again = await app.inject({
      method: 'DELETE',
      url: '/v1/campaigns/does-not-exist',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(again.statusCode).toBe(404);
  });

  it('duplicates a campaign as a draft with its email, follow-ups, AI settings and senders, but none of its leads', async () => {
    const source = await prisma.campaign.create({
      data: {
        name: 'Duplicate Me',
        status: 'PAUSED',
        aiPromptTemplate: 'Mention their city',
        template: 'Hi {{firstName}}, quick question.',
        subject: 'Quick question',
        aiProvider: 'GEMINI',
        aiMode: 'PROMPT',
        aiWritesSubject: true,
        unsubscribeUrlTemplate: 'https://example.org/u/{{token}}',
        bounceRateThreshold: 0.08,
        pausedForBounceRate: true,
        steps: {
          create: [
            { position: 1, waitDays: 3, body: 'Bumping this up.', aiRewrite: true },
            { position: 2, waitDays: 5, body: 'Last note from me.' },
          ],
        },
      },
    });
    createdCampaignIds.push(source.id);
    await linkSender(source.id);
    await prisma.lead.create({
      data: { campaignId: source.id, email: `dup-lead-${Date.now()}@example.com` },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${source.id}/duplicate`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.statusCode).toBe(201);
    const copy = response.json();
    createdCampaignIds.push(copy.id);
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      name: 'Copy of Duplicate Me',
      status: 'DRAFT',
      aiPromptTemplate: 'Mention their city',
      template: 'Hi {{firstName}}, quick question.',
      subject: 'Quick question',
      aiProvider: 'GEMINI',
      aiMode: 'PROMPT',
      aiWritesSubject: true,
      unsubscribeUrlTemplate: 'https://example.org/u/{{token}}',
      bounceRateThreshold: 0.08,
      pausedForBounceRate: false,
      mailboxIds: [mailboxId],
      steps: [
        { position: 1, waitDays: 3, body: 'Bumping this up.', aiRewrite: true },
        { position: 2, waitDays: 5, body: 'Last note from me.', aiRewrite: false },
      ],
    });
    expect(await prisma.lead.count({ where: { campaignId: copy.id } })).toBe(0);
    // The original is untouched.
    expect(await prisma.lead.count({ where: { campaignId: source.id } })).toBe(1);
    expect(await prisma.campaignStep.count({ where: { campaignId: source.id } })).toBe(2);

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/campaigns/does-not-exist/duplicate',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  const auth = () => ({ authorization: `Bearer ${authToken}` });

  it('stores subject, aiMode and aiWritesSubject, and validates them', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: auth(),
      payload: {
        name: 'Compose Fields',
        aiPromptTemplate: '',
        template: 'Hi {{firstName}}',
        subject: '  {Quick idea|An idea} for {{company}}  ',
        aiMode: 'PROMPT',
        aiWritesSubject: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const json = created.json();
    createdCampaignIds.push(json.id);
    expect(json).toMatchObject({
      subject: '{Quick idea|An idea} for {{company}}',
      aiMode: 'PROMPT',
      aiWritesSubject: true,
    });

    const defaults = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: auth(),
      payload: { name: 'Compose Defaults', aiPromptTemplate: '' },
    });
    createdCampaignIds.push(defaults.json().id);
    expect(defaults.json()).toMatchObject({
      subject: null,
      aiMode: 'PERSONALIZE',
      aiWritesSubject: false,
    });

    const badMode = await app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${json.id}`,
      headers: auth(),
      payload: { aiMode: 'FREESTYLE' },
    });
    expect(badMode.statusCode).toBe(422);

    const badSubject = await app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${json.id}`,
      headers: auth(),
      payload: { subject: '{unclosed|group' },
    });
    expect(badSubject.statusCode).toBe(422);

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${json.id}`,
      headers: auth(),
      payload: { subject: '   ', aiMode: 'PERSONALIZE' },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ subject: null, aiMode: 'PERSONALIZE' });
  });

  it('previews unsaved draft fields with a sample lead, and a saved campaign with its own leads', async () => {
    const draft = await app.inject({
      method: 'POST',
      url: '/v1/campaigns/preview',
      headers: auth(),
      payload: {
        subject: 'Idea for {{company}}',
        template: 'Hi {{firstName}}, {{title}} question.',
      },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({
      sampleLead: true,
      subject: 'Idea for Acme Logistics',
      body: 'Hi Dana, Head of Operations question.',
      aiOutcome: 'TEMPLATE',
      fallback: { subject: 'Idea for Acme Logistics' },
    });

    const campaign = await prisma.campaign.create({
      data: {
        name: 'Preview Leads',
        aiPromptTemplate: '',
        subject: 'Hi {{firstName}}',
        template: 'Body for {{company}}',
      },
    });
    createdCampaignIds.push(campaign.id);
    await prisma.lead.createMany({
      data: [
        { campaignId: campaign.id, email: 'one@acme.example', firstName: 'Ada', company: 'One Co' },
        {
          campaignId: campaign.id,
          email: 'two@acme.example',
          firstName: 'Grace',
          company: 'Two Co',
        },
      ],
    });
    const saved = await app.inject({
      method: 'POST',
      url: '/v1/campaigns/preview',
      headers: auth(),
      payload: { campaignId: campaign.id, leadIndex: 1 },
    });
    expect(saved.json()).toMatchObject({
      sampleLead: false,
      leadIndex: 1,
      subject: 'Hi Grace',
      body: 'Body for Two Co',
    });
    expect(saved.json().leads).toHaveLength(2);

    const badSpintax = await app.inject({
      method: 'POST',
      url: '/v1/campaigns/preview',
      headers: auth(),
      payload: { template: '{broken|group' },
    });
    expect(badSpintax.statusCode).toBe(422);
  });
  it('previews any one of its leads by id, from that lead’s own mailbox, with or without AI', async () => {
    const preview = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/campaigns/preview', headers: auth(), payload });
    const ownMailbox = await prisma.mailbox.create({
      data: { email: `campaigns-own-${Date.now()}@example.com`, domainId, status: 'ACTIVE' },
    });
    const campaign = await prisma.campaign.create({
      data: {
        name: 'Preview By Lead',
        aiPromptTemplate: 'Make it warmer',
        aiProvider: 'CLAUDE',
        subject: 'Hi {{firstName}}',
        template: 'Body for {{company}}',
        steps: { create: [{ position: 1, waitDays: 3, body: 'Following up, {{firstName}}' }] },
      },
    });
    createdCampaignIds.push(campaign.id);
    const other = await prisma.campaign.create({ data: { name: 'Other', aiPromptTemplate: '' } });
    createdCampaignIds.push(other.id);
    try {
      await linkSender(campaign.id);
      // Past the first three, so only `leadId` can reach it.
      await prisma.lead.createMany({
        data: ['a', 'b', 'c'].map((n) => ({ campaignId: campaign.id, email: `${n}@acme.example` })),
      });
      const lead = await prisma.lead.create({
        data: {
          campaignId: campaign.id,
          email: 'dee@acme.example',
          firstName: 'Dee',
          company: 'Dee Co',
          mailboxId: ownMailbox.id,
          threadSubject: 'Hi Dee, the subject she really got',
        },
      });
      const stranger = await prisma.lead.create({
        data: { campaignId: other.id, email: 'x@acme.example' },
      });

      const first = await preview({ campaignId: campaign.id, leadId: lead.id, skipAi: true });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        lead: { email: 'dee@acme.example' },
        subject: 'Hi Dee',
        aiOutcome: 'TEMPLATE',
        usesAi: true,
        sender: { email: ownMailbox.email },
      });
      expect(first.json().body).toMatch(/^Body for Dee Co/);

      // A follow-up replies under the subject this lead really got; this step isn't AI-rewritten.
      const followUp = await preview({ campaignId: campaign.id, leadId: lead.id, step: 1 });
      expect(followUp.json()).toMatchObject({
        subject: 'Re: Hi Dee, the subject she really got',
        aiOutcome: 'TEMPLATE',
        usesAi: false,
      });
      expect(followUp.json().body).toMatch(/^Following up, Dee/);

      expect((await preview({ campaignId: campaign.id, leadId: stranger.id })).statusCode).toBe(
        404,
      );
      expect((await preview({ leadId: lead.id })).statusCode).toBe(422);
    } finally {
      await prisma.lead.deleteMany({ where: { campaignId: { in: [campaign.id, other.id] } } });
      await prisma.campaignMailbox.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.mailbox.delete({ where: { id: ownMailbox.id } });
    }
  });

  it('previews the CAN-SPAM footer sends get, or says what is missing when sends would be refused', async () => {
    const preview = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/campaigns/preview', headers: auth(), payload });
    const draft = {
      subject: 'Idea for {{company}}',
      template: 'Hi {{firstName}},',
      mailboxIds: [mailboxId],
    };
    const savedDomain = process.env.WARMHAWK_DOMAIN;
    delete process.env.WARMHAWK_DOMAIN;
    try {
      // Both set: the body and the if-the-AI-fails body end with the footer, unsubscribe per lead.
      const complete = await preview({
        ...draft,
        unsubscribeUrlTemplate: 'https://acme.example/u?email={{email}}',
      });
      expect(complete.statusCode).toBe(200);
      const footer = `\n\n--\n${address}\nUnsubscribe: https://acme.example/u?email=dana%40acme.example`;
      expect(complete.json()).toMatchObject({
        complianceMissing: [],
        body: `Hi Dana,${footer}`,
        fallback: { body: `Hi Dana,${footer}` },
      });

      // No unsubscribe link, or one sends would refuse (not https/mailto): no footer, and why.
      for (const unsubscribeUrlTemplate of [undefined, '', 'ftp://acme.example/u']) {
        const missing = await preview({ ...draft, unsubscribeUrlTemplate });
        expect(missing.json()).toMatchObject({
          complianceMissing: ['unsubscribe'],
          body: 'Hi Dana,',
        });
      }

      // A saved campaign's own link is used when the draft doesn't send one; the draft's wins when it does.
      const campaign = await prisma.campaign.create({
        data: {
          name: 'Preview Footer',
          aiPromptTemplate: '',
          subject: draft.subject,
          template: draft.template,
          unsubscribeUrlTemplate: 'mailto:out@acme.example',
        },
      });
      createdCampaignIds.push(campaign.id);
      await linkSender(campaign.id);
      expect((await preview({ campaignId: campaign.id })).json().body).toMatch(
        /Unsubscribe: mailto:out@acme\.example$/,
      );
      expect(
        (await preview({ campaignId: campaign.id, unsubscribeUrlTemplate: '' })).json()
          .complianceMissing,
      ).toEqual(['unsubscribe']);

      // An install with a domain: no link of the campaign's own means the built-in page, signed
      // for the lead being previewed. A link sends would refuse is still reported, not replaced.
      process.env.WARMHAWK_DOMAIN = 'api.acme.example';
      const lead = await prisma.lead.create({
        data: { campaignId: campaign.id, email: 'dana@acme.example', firstName: 'Dana' },
      });
      const builtIn = (
        await preview({ campaignId: campaign.id, unsubscribeUrlTemplate: '' })
      ).json();
      expect(builtIn.complianceMissing).toEqual([]);
      expect(
        builtIn.body.endsWith(
          `Unsubscribe: https://api.acme.example/unsubscribe/${signUnsubscribeToken(lead.id)}`,
        ),
      ).toBe(true);
      expect((await preview(draft)).json().body).toMatch(
        /Unsubscribe: https:\/\/api\.acme\.example\/unsubscribe\/test-send\./,
      );
      expect(
        (await preview({ ...draft, unsubscribeUrlTemplate: 'ftp://acme.example/u' })).json()
          .complianceMissing,
      ).toEqual(['unsubscribe']);
      delete process.env.WARMHAWK_DOMAIN;

      // No sender ticked: nothing can send, and the preview says so first.
      expect(
        (
          await preview({
            ...draft,
            mailboxIds: [],
            unsubscribeUrlTemplate: 'https://acme.example/u',
          })
        ).json().complianceMissing,
      ).toEqual(['sender']);

      // The sender's domain has no mailing address: the same, naming the address.
      await prisma.domain.update({ where: { id: domainId }, data: { mailingAddress: null } });
      expect(
        (await preview({ ...draft, unsubscribeUrlTemplate: 'https://acme.example/u' })).json()
          .complianceMissing,
      ).toEqual(['address']);
      expect((await preview(draft)).json().complianceMissing).toEqual(['address', 'unsubscribe']);
    } finally {
      if (savedDomain === undefined) delete process.env.WARMHAWK_DOMAIN;
      else process.env.WARMHAWK_DOMAIN = savedDomain;
      await prisma.domain.update({ where: { id: domainId }, data: { mailingAddress: address } });
    }
  });

  it('field-check flags unknown fields and counts leads missing a custom field', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Field Check', aiPromptTemplate: '' },
    });
    createdCampaignIds.push(campaign.id);
    await prisma.lead.createMany({
      data: [
        {
          campaignId: campaign.id,
          email: 'a@acme.example',
          firstName: 'Ada',
          customFields: { title: 'COO' },
        },
        {
          campaignId: campaign.id,
          email: 'b@acme.example',
          firstName: null,
          customFields: { title: '' },
        },
      ],
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/campaigns/field-check',
      headers: auth(),
      payload: {
        campaignId: campaign.id,
        texts: ['Hi {{firstName}} ({{Title}}) — {{senderName}}', '{{caseStudyResult}}'],
      },
    });
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.leadCount).toBe(2);
    expect(json.available).toContain('title');
    expect(json.fields).toEqual([
      { name: 'firstName', status: 'partial', missingCount: 1 },
      { name: 'Title', status: 'partial', missingCount: 1 },
      { name: 'senderName', status: 'ok', missingCount: 0 },
      { name: 'caseStudyResult', status: 'unknown', missingCount: 2 },
    ]);
  });

  it('reports who wrote the last week of sends, on the list and per campaign', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'AI Writing', aiPromptTemplate: '', aiProvider: 'GEMINI' },
    });
    createdCampaignIds.push(campaign.id);
    const lead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        email: 'w@acme.example',
        firstName: 'Dana',
        company: 'Acme',
      },
    });
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await prisma.executionLog.createMany({
      data: [
        {
          campaignId: campaign.id,
          leadId: lead.id,
          mailboxId,
          status: 'SENT',
          aiOutcome: 'AI_WRITTEN',
        },
        {
          campaignId: campaign.id,
          leadId: lead.id,
          mailboxId,
          status: 'SENT',
          aiOutcome: 'AI_WRITTEN',
        },
        {
          campaignId: campaign.id,
          leadId: lead.id,
          mailboxId,
          status: 'SENT',
          aiOutcome: 'AI_FALLBACK',
          aiFallbackReason: 'model_unavailable',
        },
        {
          campaignId: campaign.id,
          leadId: lead.id,
          mailboxId,
          status: 'SENT',
          aiOutcome: 'AI_FALLBACK',
          aiFallbackReason: 'model_unavailable',
          createdAt: old,
        },
      ],
    });

    const list = await app.inject({ method: 'GET', url: '/v1/campaigns', headers: auth() });
    const row = list.json().find((c: { id: string }) => c.id === campaign.id);
    expect(row).toMatchObject({ aiWrittenCount: 2, aiFallbackCount: 1 });

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/campaigns/${campaign.id}/ai-writing`,
      headers: auth(),
    });
    expect(detail.statusCode).toBe(200);
    const json = detail.json();
    expect(json.counts).toEqual({ aiWritten: 2, template: 0, aiFallback: 1 });
    expect(json.fallbackReasons).toEqual([{ reason: 'model_unavailable', count: 1 }]);
    expect(json.recent).toHaveLength(3);
    expect(json.recent[0].lead).toEqual({ firstName: 'Dana', lastName: null, company: 'Acme' });

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/campaigns/nope/ai-writing',
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('stores a send schedule, validates it, and turns it off with sendTimezone null', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: auth(),
      payload: {
        name: 'Schedule Campaign',
        aiPromptTemplate: '',
        sendTimezone: 'America/Chicago',
        sendDays: [5, 1, 2, 3, 4],
        sendStartMinute: 9 * 60,
        sendEndMinute: 17 * 60,
        useLeadTimezone: true,
        maxNewLeadsPerDay: 40,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    createdCampaignIds.push(id);
    expect(created.json()).toMatchObject({
      sendTimezone: 'America/Chicago',
      sendDays: [1, 2, 3, 4, 5],
      sendStartMinute: 540,
      sendEndMinute: 1020,
      useLeadTimezone: true,
      maxNewLeadsPerDay: 40,
    });

    // A PATCH may change only the hours; it's checked against the saved days and zone.
    const hours = await app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${id}`,
      headers: auth(),
      payload: { sendStartMinute: 8 * 60 },
    });
    expect(hours.statusCode).toBe(200);
    expect(hours.json()).toMatchObject({ sendStartMinute: 480, sendDays: [1, 2, 3, 4, 5] });

    const bad: Record<string, unknown>[] = [
      { sendTimezone: 'Mars/Olympus' },
      { sendDays: [] },
      { sendDays: [1, 7] },
      { sendDays: [1, 1] },
      { sendStartMinute: 18 * 60 },
      { sendEndMinute: 1441 },
      { useLeadTimezone: 'yes' },
      { maxNewLeadsPerDay: 0 },
      { maxNewLeadsPerDay: 2.5 },
    ];
    for (const payload of bad) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/campaigns/${id}`,
        headers: auth(),
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
    }

    const off = await app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${id}`,
      headers: auth(),
      payload: { sendTimezone: null, maxNewLeadsPerDay: null },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({
      sendTimezone: null,
      sendDays: [],
      sendStartMinute: null,
      sendEndMinute: null,
      maxNewLeadsPerDay: null,
    });

    // A schedule needs every part on create too.
    const partial = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: auth(),
      payload: { name: 'Partial Schedule', aiPromptTemplate: '', sendTimezone: 'UTC' },
    });
    expect(partial.statusCode).toBe(422);
  });

  it('lists each campaign’s send window and next booked send, and a copy keeps the schedule', async () => {
    const closed = await prisma.campaign.create({
      data: {
        name: 'Window Closed',
        status: 'ACTIVE',
        aiPromptTemplate: '',
        sendTimezone: 'UTC',
        // Every day but today: closed now, opens at midnight UTC.
        sendDays: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== new Date().getUTCDay()),
        sendStartMinute: 0,
        sendEndMinute: 1440,
        maxNewLeadsPerDay: 25,
      },
    });
    const legacy = await prisma.campaign.create({
      data: { name: 'No Schedule', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    createdCampaignIds.push(closed.id, legacy.id);
    await linkSender(closed.id);
    const slot = new Date(Date.now() + 30 * 60_000);
    await prisma.lead.create({
      data: {
        campaignId: legacy.id,
        email: `booked-${Date.now()}@example.com`,
        status: 'QUEUED',
        queuedJobId: 'job-1',
        queuedSlotAt: slot,
      },
    });

    const list = await app.inject({ method: 'GET', url: '/v1/campaigns', headers: auth() });
    const rows = list.json() as {
      id: string;
      sendWindow: { open: boolean; nextOpenAt: string | null } | null;
      progress: { nextSendAt: string | null };
    }[];
    const closedRow = rows.find((c) => c.id === closed.id)!;
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    expect(closedRow.sendWindow).toMatchObject({ open: false });
    expect(new Date(closedRow.sendWindow!.nextOpenAt!).getTime()).toBe(midnight);
    expect(closedRow.progress.nextSendAt).toBeNull();
    const legacyRow = rows.find((c) => c.id === legacy.id)!;
    expect(legacyRow.sendWindow).toBeNull();
    expect(new Date(legacyRow.progress.nextSendAt!).getTime()).toBe(slot.getTime());

    const copy = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${closed.id}/duplicate`,
      headers: auth(),
    });
    expect(copy.statusCode).toBe(201);
    createdCampaignIds.push(copy.json().id);
    expect(copy.json()).toMatchObject({
      sendTimezone: 'UTC',
      sendDays: closed.sendDays,
      sendEndMinute: 1440,
      maxNewLeadsPerDay: 25,
    });
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/campaigns' });
    expect(response.statusCode).toBe(401);
  });
});
