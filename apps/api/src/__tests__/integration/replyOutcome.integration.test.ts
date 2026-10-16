/**
 * Integration test for `lib/replyOutcome.ts` against a REAL Postgres: what a labelled reply does to
 * its lead's follow-ups (away notice holds them, auto-reply resumes them, a real answer or
 * "no longer here" stops them), the dashboard relabel that runs it again, and the
 * `resume-auto-replied` backfill.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, type ReplyClassification } from '@warmhawk/db';
import { createApp } from '../../app';
import { applyReplyOutcome, resumeAutoRepliedLeads } from '../../lib/replyOutcome';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

describeIntegration('reply outcome (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let authToken: string;
  let domainId: string;
  let mailboxId: string;
  let campaignId: string;
  // The first email went out 2 days ago; follow-up 1 waits 3 days, so it's due tomorrow.
  const lastStepAt = new Date(Date.now() - 2 * DAY_MS);
  const scheduled = new Date(lastStepAt.getTime() + 3 * DAY_MS);

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

    const stamp = Date.now();
    const domain = await prisma.domain.create({
      data: { domainName: `reply-outcome-${stamp}.example.com` },
    });
    domainId = domain.id;
    const mailbox = await prisma.mailbox.create({
      data: { email: `ro-sender-${stamp}@example.com`, domainId },
    });
    mailboxId = mailbox.id;
    const campaign = await prisma.campaign.create({
      data: {
        name: 'Reply Outcome Test',
        status: 'ACTIVE',
        aiPromptTemplate: '',
        steps: {
          create: [
            { position: 1, waitDays: 3, body: 'Following up' },
            { position: 2, waitDays: 4, body: 'Last one' },
          ],
        },
      },
    });
    campaignId = campaign.id;
  });

  afterAll(async () => {
    await prisma.reply.deleteMany({ where: { campaignId } });
    await prisma.executionLog.deleteMany({ where: { campaignId } });
    await prisma.lead.deleteMany({ where: { campaignId } });
    await prisma.campaignStep.deleteMany({ where: { campaignId } });
    await prisma.campaign.deleteMany({ where: { id: campaignId } });
    await prisma.mailbox.deleteMany({ where: { id: mailboxId } });
    await prisma.domain.deleteMany({ where: { id: domainId } });
    await app.close();
    await prisma.$disconnect();
  });

  /** A lead the reply poll just stopped: REPLIED, follow-up cleared, one reply with this label. */
  async function stoppedLead(
    classification: ReplyClassification,
    rawContent: string,
    repliedAt = new Date(),
  ) {
    const lead = await prisma.lead.create({
      data: {
        campaignId,
        email: `ro-${classification.toLowerCase()}-${Math.random().toString(36).slice(2)}@example.com`,
        status: 'REPLIED',
        mailboxId,
        stepsSent: 1,
        lastStepAt,
        nextStepAt: null,
      },
    });
    const reply = await prisma.reply.create({
      data: {
        leadId: lead.id,
        campaignId,
        mailboxId,
        rawContent,
        classification,
        classifiedAt: new Date(),
        repliedAt,
      },
    });
    return { lead, reply };
  }

  it('an auto-reply starts the follow-ups again on their old schedule', async () => {
    const { lead, reply } = await stoppedLead(
      'AUTO_REPLY',
      'Thanks for contacting support. Your ticket #4412 has been received.',
    );

    expect(await applyReplyOutcome(reply.id)).toBe('resumed');

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('CONTACTED');
    expect(after.nextStepAt).toEqual(scheduled);
  });

  it('an away notice holds them until the day after the return date', async () => {
    const back = new Date(Date.now() + 10 * DAY_MS);
    const backText = back.toISOString().slice(0, 10);
    const { lead, reply } = await stoppedLead(
      'OUT_OF_OFFICE',
      `I am out of the office until ${backText} with limited access to email.`,
    );

    expect(await applyReplyOutcome(reply.id)).toBe('paused');

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('CONTACTED');
    expect(after.nextStepAt?.getTime()).toBe(
      new Date(`${backText}T00:00:00.000Z`).getTime() + DAY_MS,
    );
  });

  it('an away notice with no date holds them a week; an earlier schedule never wins', async () => {
    const repliedAt = new Date();
    const { lead, reply } = await stoppedLead(
      'OUT_OF_OFFICE',
      'I am currently out of the office.',
      repliedAt,
    );

    expect(await applyReplyOutcome(reply.id)).toBe('paused');

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.nextStepAt?.getTime()).toBe(repliedAt.getTime() + 7 * DAY_MS);
  });

  it('an opened lead goes back to OPENED', async () => {
    const { lead, reply } = await stoppedLead('AUTO_REPLY', 'We got your message.');
    await prisma.executionLog.create({
      data: { leadId: lead.id, campaignId, mailboxId, status: 'OPENED' },
    });

    await applyReplyOutcome(reply.id);

    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('OPENED');
  });

  it('"no longer with the company" keeps the sequence stopped', async () => {
    const { lead, reply } = await stoppedLead(
      'LEFT_COMPANY',
      'Jane is no longer with the company.',
    );

    expect(await applyReplyOutcome(reply.id)).toBe('unchanged');

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('REPLIED');
    expect(after.nextStepAt).toBeNull();
  });

  it('an auto-reply after a real answer changes nothing', async () => {
    const { lead } = await stoppedLead('INTERESTED', 'Sure, send details.');
    const auto = await prisma.reply.create({
      data: {
        leadId: lead.id,
        campaignId,
        mailboxId,
        rawContent: 'Automatic reply: ticket received.',
        classification: 'AUTO_REPLY',
        classifiedAt: new Date(),
        repliedAt: new Date(),
      },
    });

    expect(await applyReplyOutcome(auto.id)).toBe('unchanged');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
      'REPLIED',
    );
  });

  it('never touches a suppressed lead', async () => {
    const { lead, reply } = await stoppedLead('AUTO_REPLY', 'We got your message.');
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'SUPPRESSED' } });

    expect(await applyReplyOutcome(reply.id)).toBe('unchanged');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
      'SUPPRESSED',
    );
  });

  it('relabelling in the dashboard moves the lead with the label', async () => {
    const { lead, reply } = await stoppedLead('UNCLASSIFIED', 'Thanks, we will get back to you.');
    const relabel = (classification: ReplyClassification) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/replies/${reply.id}`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: { classification },
      });

    expect((await relabel('AUTO_REPLY')).statusCode).toBe(200);
    let after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('CONTACTED');
    expect(after.nextStepAt).toEqual(scheduled);

    expect((await relabel('INTERESTED')).statusCode).toBe(200);
    after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('REPLIED');
    expect(after.nextStepAt).toBeNull();
  });

  it('the backfill counts on a dry run, then resumes only leads every reply of which kept going', async () => {
    // Leads the earlier tests left REPLIED are this campaign's only other candidates; clear them.
    await prisma.reply.deleteMany({ where: { campaignId } });
    await prisma.lead.deleteMany({ where: { campaignId } });
    const auto = await stoppedLead('AUTO_REPLY', 'Ticket #9 received.');
    const away = await stoppedLead('OUT_OF_OFFICE', 'Out of office.');
    const real = await stoppedLead('NOT_INTERESTED', 'No thanks.');

    const counted = await resumeAutoRepliedLeads(true);
    expect(counted.found).toBeGreaterThanOrEqual(2);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: auto.lead.id } })).status).toBe(
      'REPLIED',
    );

    const done = await resumeAutoRepliedLeads(false);
    expect(done.resumed + done.paused).toBeGreaterThanOrEqual(2);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: auto.lead.id } })).status).toBe(
      'CONTACTED',
    );
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: away.lead.id } })).status).toBe(
      'CONTACTED',
    );
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: real.lead.id } })).status).toBe(
      'REPLIED',
    );
  });
});
