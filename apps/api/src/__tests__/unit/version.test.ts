/**
 * `GET /v1/version` (`routes/version.ts`): the release tag baked into the image, for the operator
 * dashboard's version chip.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../app';
import { readReleaseVersion } from '../../routes/version';

describe('GET /v1/version', () => {
  let app: FastifyInstance;
  const originalToken = process.env.OPERATOR_SERVICE_TOKEN;
  const originalFile = process.env.WARMHAWK_RELEASE_VERSION_FILE;
  const dir = mkdtempSync(join(tmpdir(), 'wh-version-'));

  beforeEach(async () => {
    process.env.OPERATOR_SERVICE_TOKEN = 'test-operator-token';
    app = await createApp();
  });

  afterEach(async () => {
    process.env.OPERATOR_SERVICE_TOKEN = originalToken;
    process.env.WARMHAWK_RELEASE_VERSION_FILE = originalFile;
    await app.close();
  });

  it('returns the baked release version, without a leading v', async () => {
    const file = join(dir, 'RELEASE_VERSION');
    writeFileSync(file, 'v1.19.1\n');
    process.env.WARMHAWK_RELEASE_VERSION_FILE = file;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/version',
      headers: { authorization: 'Bearer test-operator-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: '1.19.1' });
  });

  it('needs auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/version' });
    expect(response.statusCode).toBe(401);
  });

  it('reports null for an image built without a release tag', () => {
    const empty = join(dir, 'EMPTY');
    writeFileSync(empty, '');
    expect(readReleaseVersion(empty)).toBeNull();
    expect(readReleaseVersion(join(dir, 'missing'))).toBeNull();
    expect(readReleaseVersion(undefined)).toBeNull();
  });
});
