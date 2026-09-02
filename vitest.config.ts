import { defineConfig } from 'vitest/config';

/**
 * Default (unit) Vitest config — fast, no external dependencies. Integration tests (files named
 * `*.integration.test.ts`) are excluded here and run instead via `npm run test:integration`
 * (vitest.integration.config.ts), which points DATABASE_URL/REDIS_URL at docker-compose.test.yml
 * and serializes workers per the V12 process lesson below.
 */
export default defineConfig({
  test: {
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**', '**/generated/**'],
    environment: 'node',
    globals: false,
  },
});
