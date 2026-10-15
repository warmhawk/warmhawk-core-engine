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

  // A literal `proxy_pass http://api:4600` is resolved once at nginx start: after an API restart
  // on a new address, every route 502s until nginx restarts too (hit live 2026-10-15).
  it('reaches the API through the re-resolving $warmhawk_api variable only', () => {
    const root = resolve(__dirname, '../../../../..');
    const nginx = readFileSync(resolve(root, 'nginx/nginx.conf.template'), 'utf8');
    const cli = readFileSync(resolve(root, 'scripts/warmhawk'), 'utf8');
    expect(nginx).toMatch(/^resolver 127\.0\.0\.11 /m);
    expect(nginx).not.toMatch(/proxy_pass http:\/\/api:/);
    expect(cli).not.toMatch(/proxy_pass http:\/\/api:/);
    expect(cli).toContain('proxy_pass \\$warmhawk_api;');
  });

  // install.sh/update.sh's enable_tls_template() keeps only the lines after its marker, uncommented.
  // Anything the live blocks rely on that sits above the marker has to be repeated below it, or a
  // TLS install (every real one) loses it: the release e2e caught nginx not starting (2026-10-15).
  it('keeps the resolver, the $warmhawk_api map and the link-domain include once TLS is enabled', () => {
    const root = resolve(__dirname, '../../../../..');
    const nginx = readFileSync(resolve(root, 'nginx/nginx.conf.template'), 'utf8');
    const awk = 'index($0, "Enabled by scripts/install.sh") > 0 { found=1; next }';
    for (const script of ['scripts/install.sh', 'scripts/update.sh']) {
      expect(readFileSync(resolve(root, script), 'utf8')).toContain(awk);
    }
    const lines = nginx.split('\n');
    const marker = lines.findIndex((line) => line.includes('Enabled by scripts/install.sh'));
    expect(marker).toBeGreaterThan(0);
    const tls = lines
      .slice(marker + 1)
      .map((line) => line.replace(/^# ?/, ''))
      .join('\n');
    for (const rendered of [nginx, tls]) {
      expect(rendered).toMatch(/^resolver 127\.0\.0\.11 /m);
      expect(rendered).toMatch(/^map \$host \$warmhawk_api \{\n {4}default http:\/\/api:4600;\n\}$/m);
      expect(rendered).toMatch(/^include \/etc\/nginx\/link-domains\/\*\.conf;$/m);
    }
    expect(tls).toMatch(/^ {4}listen 443 ssl;$/m);
    expect(tls).toContain('proxy_pass $warmhawk_api;');
  });

  // A brand's link host (`warmhawk link-domain add`) must never expose the API or the dashboard:
  // the server blocks scripts/warmhawk writes proxy /unsubscribe/ and nothing else.
  it('loads link-domain blocks, and those proxy /unsubscribe/ only', () => {
    const root = resolve(__dirname, '../../../../..');
    const nginx = readFileSync(resolve(root, 'nginx/nginx.conf.template'), 'utf8');
    expect(nginx).toMatch(/^include \/etc\/nginx\/link-domains\/\*\.conf;$/m);
    const cli = readFileSync(resolve(root, 'scripts/warmhawk'), 'utf8');
    const proxied = [...cli.matchAll(/location (\S+) \{ proxy_pass/g)].map((m) => m[1]);
    expect(proxied).toEqual(['/unsubscribe/']);
    expect(cli).toContain('location / { return 404; }');
  });
});
