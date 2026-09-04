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
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
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

/**
 * Bug-fix regression coverage (live-stack verification, 2026-09-04) — sends the FILE part
 * before the `campaignId` field, as a REAL two-write HTTP request against a real listening
 * server, with a genuine async gap between the writes. This is deliberately NOT built as one
 * `Buffer` handed to `app.inject()`: an earlier version of this test did exactly that (file part
 * first inside one static buffer) and it passed even against the unpatched route. Root cause of
 * that false negative: `@fastify/multipart` (busboy under the hood) only actually loses the race
 * when the bytes for the file part and the bytes for a field declared after it arrive in
 * SEPARATE stream `data` events — when everything lands in one chunk (which is exactly what
 * `app.inject()` with a single Buffer payload does, and also what a small file sent as one raw
 * curl `-F` request over loopback does), busboy parses the whole buffer synchronously — file
 * event AND the later field event both fire — before the route's `await request.file(...)` even
 * gets a microtask turn to read `.fields.campaignId`, so it's already populated by the time the
 * check runs. The real, live browser bug (found through warmhawk-enterprise-operator's
 * `import-leads-dialog.tsx`, which appends the file before campaignId) only actually manifested
 * because the request crosses the operator's `/api/backend/*` proxy — a second hop that reads
 * the incoming body then re-serializes a fresh outbound multipart request, reliably splitting
 * the file part from the trailing campaignId field across separate writes/`data` events on
 * core-engine's side. This test reproduces that same "file event, then a real async gap, then
 * the field event" shape directly against core-engine, without needing the second repo's proxy
 * running, by writing the two halves of the multipart body to the socket with a real `setTimeout`
 * gap in between.
 */
async function postFileThenFieldOverRealSocket(opts: {
  port: number;
  path: string;
  authToken: string;
  file: { fieldName: string; filename: string; content: string };
  fields: Record<string, string>;
}): Promise<{ statusCode: number; body: unknown }> {
  const boundary = `----WarmHawkTestBoundaryDelayed${Date.now()}`;
  const filePart =
    `--${boundary}\r\nContent-Disposition: form-data; name="${opts.file.fieldName}"; filename="${opts.file.filename}"\r\nContent-Type: text/csv\r\n\r\n${opts.file.content}\r\n`;
  const fieldParts = Object.entries(opts.fields)
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join('');
  const closing = `--${boundary}--\r\n`;

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Bearer ${opts.authToken}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);

    // Write the file part, flush it as its own TCP write, then genuinely wait a tick (real
    // macrotask gap, not just a microtask) before writing the campaignId field — this is what
    // forces busboy to emit the 'file' event and hand control back to the awaiting route handler
    // BEFORE the campaignId field has been parsed, matching what the operator's proxy re-hop
    // does to a real browser-originated import.
    req.write(filePart, () => {
      setTimeout(() => {
        req.end(fieldParts + closing);
      }, 50);
    });
  });
}

describeIntegration('POST /leads/import (integration, real Postgres)', () => {
  let app: FastifyInstance;
  let campaignId: string;
  let authToken: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-not-a-real-secret-value';
    app = await createApp();
    await app.ready();
    // Real listener (not just app.ready()) — the file-before-field regression test below needs a
    // genuine socket so it can deliver the multipart body as two separate TCP writes; see that
    // test's own comment for why app.inject() with a single Buffer can't exercise this race.
    await app.listen({ port: 0, host: '127.0.0.1' });

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

  it('imports successfully when the file part arrives in a separate TCP write before the campaignId field, matching a real browser upload through the operator proxy (regression, 2026-09-04)', async () => {
    const csv = 'email\nbrowser-order@example.org\n';
    const address = app.server.address() as AddressInfo;

    const response = await postFileThenFieldOverRealSocket({
      port: address.port,
      path: '/v1/leads/import',
      authToken,
      file: { fieldName: 'file', filename: 'leads.csv', content: csv },
      fields: { campaignId },
    });

    expect(response.statusCode).toBe(200);
    const json = response.body as { imported: number; rejected: unknown[] };
    expect(json.imported).toBe(1);
    expect(json.rejected).toHaveLength(0);

    const leads = await prisma.lead.findMany({ where: { campaignId } });
    expect(leads.map((l) => l.email)).toContain('browser-order@example.org');
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
