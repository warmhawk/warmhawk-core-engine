import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// nginx only proxies /v1 prefixes it has a location block for — a route group registered in
// app.ts without one is unreachable from outside and gets nginx's own 404.
describe('nginx.conf.template', () => {
  it('has a location block for every /v1 route group in app.ts', () => {
    const root = resolve(__dirname, '../../../../..');
    const app = readFileSync(resolve(root, 'apps/api/src/app.ts'), 'utf8');
    const nginx = readFileSync(resolve(root, 'nginx/nginx.conf.template'), 'utf8');
    const prefixes = [...app.matchAll(/v1\.register\(\w+, \{ prefix: '\/([\w-]+)/g)].map((m) => m[1]);
    const live = nginx.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    const missing = [...new Set(prefixes)].filter((p) => !live.includes(`location /v1/${p}/ {`));
    expect(prefixes.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  // The link in every campaign email. With no location block, nginx 404s it and nobody can opt out.
  it('proxies the built-in unsubscribe page in the live block and in both TLS blocks', () => {
    const root = resolve(__dirname, '../../../../..');
    const nginx = readFileSync(resolve(root, 'nginx/nginx.conf.template'), 'utf8');
    expect(nginx.match(/^#?\s*location \/unsubscribe\/ \{$/gm)).toHaveLength(3);
    expect(nginx.match(/^ {4}location \/unsubscribe\/ \{$/gm)).toHaveLength(1);
  });
});
