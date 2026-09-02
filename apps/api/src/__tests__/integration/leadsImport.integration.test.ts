/**
 * Integration test for `POST /leads/import` against a REAL Postgres (docker-compose.test.yml),
 * per the Testing Strategy row: "Full route behavior: POST /leads/import... against a real
 * Postgres + Redis (docker-compose.test.yml, not mocks)."
 *
 * Skipped automatically when DATABASE_URL isn't set, so the fast unit suite (`npm test`) never
 * requires a live database — run via `npm run test:integration` instead, which points
 * DATABASE_URL at the docker-compose.test.yml stack. Per the V12 process lesson, integration
 * tests sharing one real Postgres instance run serialized (`maxWorkers: 1`, configured in
 * vitest.integration.config.ts), not in parallel.
 *
 * Fixture domain note (cleanup-pass fix): every lead email below uses `@example.org`, NOT
 * `@example.com` — `example.com` is on `leadIngest.ts`'s own `BLOCKED_EMAIL_DOMAINS` list (a real,
 * intentional Guardrails anti-junk-data check), so using it here silently rejected every fixture
 * row as `blocked_domain` before any of the suppression/duplicate/csv-injection logic this file
 * actually means to exercise ever ran. `leadIngest.test.ts`'s own unit tests already use
 * `example.org` for valid-lead fixtures for exactly this reason — match that convention here too.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { prisma } from '@warmhawk/db';

const hasIntegrationEnv = Boolean(process.env.DATABASE_URL);
const describeIntegration = hasIntegrationEnv ? describe : describe.skip;

/** Builds a raw multipart/form-data body (one text field + one file field) without pulling in an
 *  extra dependency — Fastify's `app.inject` accepts a raw payload + matching content-type. */
function buildMultipartBody(
  fields: Record<string, string>,
  file: { fieldName: string; filename: string; content: string },
) {
  const boundary = `----WarmHawkTestBoundary${Date.now()}`;
  const parts: string[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }

  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: text/csv\r\n\r\n${file.content}\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);

  return {
    body: Buffer.from(parts.join(''), 'utf8'),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describeIntegration('POST /leads/import (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let campaignId: string;
  let authToken: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    app = await createApp();
    await app.ready();

    const campaign = await prisma.campaign.create({
      data: { name: 'CSV Import Test Campaign', status: 'ACTIVE', aiPromptTemplate: '' },
    });
    campaignId = campaign.id;

    const jwt = await import('jsonwebtoken');
    authToken = jwt.default.sign(
      { sub: 'test-user', email: 'test@example.org', role: 'ADMIN' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
  });

  afterAll(async () => {
    await prisma.campaign.delete({ where: { id: campaignId } }).catch(() => undefined);
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.lead.deleteMany({ where: { campaignId } });
    await prisma.suppressionEntry.deleteMany({ where: { email: 'suppressed@example.org' } });
  });

  it('imports valid rows, skips a suppressed email, and rejects a CSV-injection row', async () => {
    await prisma.suppressionEntry.create({
      data: { email: 'suppressed@example.org', reason: 'test fixture', source: 'manual' },
    });

    const csv =
      'email,firstName,company\n' +
      'good@example.org,Good,Acme\n' +
      'suppressed@example.org,Sup,Pressed\n' +
      'bad@example.org,=cmd|calc,Evil Corp\n';

    const { body, contentType } = buildMultipartBody(
      { campaignId },
      {
        fieldName: 'file',
        filename: 'leads.csv',
        content: csv,
      },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/leads/import',
      headers: { 'content-type': contentType, authorization: `Bearer ${authToken}` },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.imported).toBe(1);
    expect(json.skippedSuppressed).toBe(1);
    expect(json.rejected).toHaveLength(1);
    expect(json.rejected[0].reason).toBe('csv_injection_risk');

    const leads = await prisma.lead.findMany({ where: { campaignId } });
    expect(leads).toHaveLength(1);
    expect(leads[0].email).toBe('good@example.org');
  });

  it('skips a duplicate row already present for the same campaign', async () => {
    await prisma.lead.create({
      data: { campaignId, email: 'dup@example.org', status: 'UNTOUCHED' },
    });

    const csv = 'email\ndup@example.org\nfresh@example.org\n';
    const { body, contentType } = buildMultipartBody(
      { campaignId },
      {
        fieldName: 'file',
        filename: 'leads.csv',
        content: csv,
      },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/leads/import',
      headers: { 'content-type': contentType, authorization: `Bearer ${authToken}` },
      payload: body,
    });

    const json = response.json();
    expect(json.imported).toBe(1);
    expect(json.skippedDuplicate).toBe(1);
  });

  it('requires authentication', async () => {
    const csv = 'email\na@example.org\n';
    const { body, contentType } = buildMultipartBody(
      { campaignId },
      {
        fieldName: 'file',
        filename: 'leads.csv',
        content: csv,
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/leads/import',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(response.statusCode).toBe(401);
  });
});
