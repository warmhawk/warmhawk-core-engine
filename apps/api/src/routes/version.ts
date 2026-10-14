/**
 * `GET /v1/version`: the release this engine was built from, for the operator dashboard's version
 * chip. The release build writes the tag into the image (`docker/Dockerfile.api`, from
 * ks-woodpecker-config's RELEASED_VERSION) and points `WARMHAWK_RELEASE_VERSION_FILE` at it.
 * `version` is null for an image built without a release tag (local builds, `tsx` in dev), so the
 * dashboard shows nothing rather than a made-up number.
 *
 * Behind `requireAuth` rather than on the public `/health`: the exact version tells a stranger
 * which known bugs to try.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../lib/requireAuth';

export function readReleaseVersion(
  file: string | undefined = process.env.WARMHAWK_RELEASE_VERSION_FILE,
): string | null {
  if (!file) return null;
  try {
    return readFileSync(file, 'utf8').trim().replace(/^v/i, '') || null;
  } catch {
    return null;
  }
}

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => ({ version: readReleaseVersion() }));
}
