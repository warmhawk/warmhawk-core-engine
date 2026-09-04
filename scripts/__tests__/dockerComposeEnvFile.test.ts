import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Regression guard for the `.env/.env`-is-a-directory situation (see `.gitignore`: `.env/.env` is
 * gitignored, `.env/.env.example` is tracked — a deliberate layout so the example can be committed
 * without the real secrets file living at repo root). Docker Compose's own automatic `.env`
 * auto-load only ever recognizes a literal file named `.env` at the project root, never
 * `.env/.env` — so every `docker compose` invocation in this repo's real install/update automation
 * has to pass `--env-file ".env/.env"` explicitly, or every `${VAR}` substitution in
 * `docker/docker-compose.yml` silently resolves blank (hard-failing only where a service happens to
 * guard with `:?`).
 *
 * `scripts/install.sh` and `scripts/update.sh` already do this correctly everywhere — this test
 * doesn't change that, it just makes sure it STAYS that way: a `docker compose ... -f ...` call
 * that drops `--env-file` is the actual reproduction of the README-documented bug, and would
 * otherwise only surface manually (a customer's stack silently missing config, or a CI run months
 * from now).
 */
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPTS = ['install.sh', 'update.sh'].map((name) => path.join(REPO_ROOT, 'scripts', name));

function nonCommentLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('docker compose invocations always pass --env-file (scripts/install.sh, scripts/update.sh)', () => {
  for (const script of SCRIPTS) {
    it(`${path.basename(script)}: every real "docker compose ... -f ..." call includes --env-file`, () => {
      const lines = nonCommentLines(readFileSync(script, 'utf8'));
      // "docker compose ... -f <compose-file> ..." is a real stack-affecting invocation (up/run/
      // build/pull/ps against an actual compose file); "docker compose version" and human-readable
      // messages mentioning "docker compose" in passing never carry " -f " and are correctly not
      // flagged.
      const realInvocationsMissingEnvFile = lines.filter(
        (line) => line.includes('docker compose') && line.includes(' -f ') && !line.includes('--env-file'),
      );
      expect(realInvocationsMissingEnvFile).toEqual([]);
    });
  }

  it('sanity check: at least one real --env-file invocation exists in each script (guards the scanner itself)', () => {
    for (const script of SCRIPTS) {
      const lines = nonCommentLines(readFileSync(script, 'utf8'));
      const realInvocations = lines.filter((line) => line.includes('docker compose') && line.includes(' -f '));
      expect(realInvocations.length).toBeGreaterThan(0);
      expect(realInvocations.every((line) => line.includes('--env-file'))).toBe(true);
    }
  });
});
