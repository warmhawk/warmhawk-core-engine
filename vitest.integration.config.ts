import { defineConfig } from 'vitest/config';

/**
 * Integration Vitest config — runs against a REAL Postgres + Redis (docker-compose.test.yml),
 * never mocks. Per the V12 process lesson ("Integration tests sharing one real Postgres/Redis
 * instance must run serialized, not in parallel — WarmHawk's own CPU-heavy operations (bcrypt for
 * license/2FA, AES-256-GCM encrypt/decrypt) are exactly the kind of contention-prone work that
 * produces timing-flaky failures under parallel workers"), `maxWorkers` is pinned to 1 here.
 *
 * Run via `npm run test:integration` after bringing up `docker-compose.test.yml`
 * (`docker compose -f docker/docker-compose.yml -f docker/docker-compose.test.yml up -d`) and
 * exporting DATABASE_URL/REDIS_URL to
 * point at it. Every integration test file in this repo checks for those env vars and
 * self-skips (`describe.skip`) when they're absent, so this config can also just be pointed at
 * in CI where the env vars are always set.
 */
export default defineConfig({
  test: {
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/generated/**'],
    environment: 'node',
    globals: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
