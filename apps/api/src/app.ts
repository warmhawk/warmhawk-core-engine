/**
 * WarmHawk Core Engine — Fastify app assembly.
 *
 * Built on Fastify per the EXPLICIT instructions elsewhere in the spec (`@fastify/rate-limit`
 * named specifically for every public-facing endpoint): security headers via `@fastify/helmet`,
 * CORS via `@fastify/cors`, JSON bodies via Fastify's built-in parser, and file uploads via
 * `@fastify/multipart`.
 */
import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';

import { domainsRoutes } from './routes/domains';
import { oauthCallbackRoutes } from './routes/oauthCallback';
import { imapRoutes } from './routes/imap';
import { leadsRoutes } from './routes/leads';
import { webhookLeadsRoutes } from './routes/webhookLeads';
import { aiProvidersRoutes } from './routes/aiProviders';
import { internalAiRoutes } from './routes/internalAi';
import { internalMailRoutes } from './routes/internalMail';
import { internalMailboxesRoutes } from './routes/internalMailboxes';
import { internalDomainsRoutes } from './routes/internalDomains';
import { internalSeedPlacementRoutes } from './routes/internalSeedPlacement';
import { internalRepliesRoutes } from './routes/internalReplies';
import { repliesRoutes } from './routes/replies';
import { authRoutes } from './routes/auth';
import { instanceSettingsRoutes } from './routes/instanceSettings';
import { campaignsRoutes } from './routes/campaigns';
import { mailboxesRoutes } from './routes/mailboxes';
import { queueRoutes } from './routes/queue';
import { seedAccountsRoutes } from './routes/seedAccounts';

/**
 * How many reverse proxies sit between this app and the caller, from `TRUST_PROXY_HOPS`.
 *
 * Defaults to 1: the bundled nginx (docker-compose.yml) is the only thing that ever reaches
 * `api`, which publishes no host port. A customer fronting that nginx with a CDN or a load
 * balancer adds one hop each and must say so here.
 *
 * A bad value is refused at boot rather than coerced. `0` would silently reinstate the
 * single-shared-bucket bug this exists to fix, and `NaN` is rejected deep inside proxy-addr with
 * an error that doesn't name the environment variable that caused it.
 */
function trustedProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return 1;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUST_PROXY_HOPS must be a non-negative integer, got: ${JSON.stringify(raw)}`);
  }
  return hops;
}

export async function createApp(): Promise<FastifyInstance> {
  // Read once, before Fastify is constructed, so a bad value fails the call to createApp() rather
  // than the first request that happens to reach the predicate below.
  const trustedHops = trustedProxyHops();

  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL || 'info' },
    // Bug fix: without this, every rate limit in the app shared ONE bucket.
    // `@fastify/rate-limit` keys on `request.ip`, and behind the bundled nginx that is always
    // nginx's own container address — the same value for every caller on earth. So the 100/min
    // global default below, and every per-route limit the Guardrails section names (webhook
    // ingest, CSV import, license activation, login), were a single global allowance that one
    // noisy caller could exhaust for everybody. That is the exact opposite of what a per-caller
    // limit is for, and it fails silently: the limiter looks configured and does fire, just
    // against the wrong subject.
    //
    // 🔴 The value is a HOP COUNT, deliberately not `true`. `trustProxy: true` trusts the whole
    // X-Forwarded-For chain, so any caller could prepend a forged address and mint itself a
    // fresh bucket on every request — swapping a shared-bucket bug for a limit-evasion bug. A
    // number means "trust exactly N proxies nearest this server" and discards anything further
    // out, so a forged prefix is ignored.
    //
    // This only works because nginx.conf.template actually SETS X-Forwarded-For. It did not
    // until this same fix; with no header to read, `trustProxy` alone changes nothing. The two
    // halves have to ship together.
    //
    // Spelled as a predicate rather than the plain number `trustedProxyHops()`, because Fastify's
    // typings for this version accept only `string | boolean | string[] | TrustProxyFunction` —
    // the numeric form works at runtime (proxy-addr supports it) but does not typecheck. This is
    // byte-for-byte what proxy-addr compiles a number into: it walks the address chain outward
    // from the socket (hop 0) and stops at the first hop it is not told to trust, so the returned
    // address is the last one a trusted proxy appended.
    trustProxy: (_address: string, hop: number) => hop < trustedHops,
  });

  // Security headers (Phase 1 hardening).
  await app.register(helmet, { global: true });

  // CORS — origin-gated; the licensed dashboard is the only expected browser-side caller.
  await app.register(cors, {
    origin: process.env.DASHBOARD_APP_URL || 'http://localhost:4610',
  });

  // Global rate limiting default — per-route overrides below apply the specific limits named in
  // the Guardrails section (webhook ingest, CSV import, license activation, login, public
  // domain-check). This global default is a conservative floor for every other route.
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
  });

  // Multipart file upload — CSV import (`POST /leads/import`), memory storage, size-capped
  // (see constants.ts MAX_CSV_FILE_BYTES).
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // MAX_CSV_FILE_BYTES — kept in sync manually; see constants.ts
      files: 1,
    },
  });

  // Bug fix: this MUST be registered before any route (`app.get`/`.post`/etc. — including the
  // `/health` route below and every plugin registered further down) is defined. Fastify snapshots
  // the CURRENT error handler onto each route's own context at the moment that route is declared
  // (`lib/route.js`: `context.errorHandler = ... : this[kErrorHandler]`) — it is not a live/lazy
  // lookup at request time. This handler used to be registered at the very end of this function,
  // AFTER every route in the app, which meant it silently never applied to a single one of them:
  // every uncaught error fell through to Fastify's own default `{statusCode, error: 'Internal
  // Server Error', message}` shape instead of this one's `{error: message}` shape. Invisible until
  // now because every other route in this repo catches its own errors and replies manually
  // (`.catch(() => null)` + `reply.code(404)...`); `routes/imap.ts` is the one file that lets a
  // raw `Error` (e.g. `openImapClient`'s "Mailbox not found") bubble up uncaught, and its new
  // integration test (`imap.integration.test.ts`) is what caught this.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({ error: error.message || 'Internal server error' });
  });

  // Unversioned, infra-facing — Docker healthcheck / Uptime Kuma probe this directly and must not
  // need to know an API version, same convention as every other health endpoint in this stack.
  app.get('/health', async () => ({ status: 'ok' }));

  // Public API surface, versioned per spec (`/v1/...`). Hard cutover, not a transitional
  // dual-mount: nothing is live in production yet (no external consumer exists outside this same
  // repo family — the operator dashboard, n8n workflows, and the e2e-install script are all
  // updated in this same effort), so there's no bare-path deprecation window to preserve.
  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: '/auth' });
      await v1.register(instanceSettingsRoutes, { prefix: '/instance-settings' });
      await v1.register(domainsRoutes, { prefix: '/domains' });
      await v1.register(oauthCallbackRoutes, { prefix: '/oauth' });
      await v1.register(leadsRoutes, { prefix: '/leads' });
      // Path-shape fix: spec names this `POST /v1/leads/webhook`, not `/webhooks/leads`. Mounted
      // as its own plugin under `/leads/webhook` (distinct from `leadsRoutes`' `/leads` prefix
      // above) — Fastify's router is a trie, not literal-prefix matching, so two plugins can share
      // a path segment without colliding as long as no two routes resolve to the same full path.
      await v1.register(webhookLeadsRoutes, { prefix: '/leads/webhook' });
      await v1.register(campaignsRoutes, { prefix: '/campaigns' });
      await v1.register(mailboxesRoutes, { prefix: '/mailboxes' });
      await v1.register(queueRoutes, { prefix: '/queue' });
      await v1.register(aiProvidersRoutes, { prefix: '/ai-providers' });
      await v1.register(repliesRoutes, { prefix: '/replies' });
      await v1.register(seedAccountsRoutes, { prefix: '/seed-accounts' });
      // NOTE: this repo no longer registers a Stripe webhook / license-issuance route (V12 fix —
      // that logic was built here by mistake during a parallel-agent build; Stripe/RSA license
      // issuance now lives solely on WarmHawk's billing/marketing site, the one piece of billing
      // infra WarmHawk operates centrally; the licensed dashboard is the sole license VERIFIER).
      // Tier 0 (this engine) carries no license gate at all, per the spec.
      //
      // NOTE: there is deliberately no `/v1/public/*` group here. A `GET /public/domain-check`
      // route once lived in this repo — WarmHawk's own free marketing tool, shipped into every
      // self-hosted install. That put an unauthenticated, recursive-DNS endpoint on customers'
      // servers, where a stranger abusing it got the CUSTOMER's IP throttled by Spamhaus and
      // silently broke the domain monitoring they actually pay for. It now runs as a separate
      // service that WarmHawk operates. Nothing unauthenticated belongs under /v1.
    },
    { prefix: '/v1' },
  );

  // Internal-only routes — guarded by requireCallbackSecret AND, per the Containerization Model,
  // reachable only over the internal Docker network (nginx never proxies these paths; there is
  // no nginx location block for `/internal/*` anywhere in this repo's nginx config).
  await app.register(internalAiRoutes, { prefix: '/internal/ai' });
  await app.register(internalMailRoutes, { prefix: '/internal/mail' });
  await app.register(internalMailboxesRoutes, { prefix: '/internal/mailboxes' });
  await app.register(internalDomainsRoutes, { prefix: '/internal/domains' });
  await app.register(internalSeedPlacementRoutes, { prefix: '/internal/seed-placement' });
  await app.register(internalRepliesRoutes, { prefix: '/internal/replies' });
  // Fix: imapRoutes was previously mounted under the public /v1 group despite every route in it
  // being n8n-machine-only (guarded by requireCallbackSecret, never a public-client concern).
  // nginx never actually had a `/v1/imap/` location block (see nginx.conf.template's explicit
  // per-path allowlist), so this wasn't externally reachable — but it relied on that omission
  // alone rather than living under `/internal/*` like every other machine-only route, one
  // future nginx edit away from becoming exposed. Moved for the same reason
  // `internalRepliesRoutes` above was split out of the actually-externally-reachable `/v1/replies`.
  await app.register(imapRoutes, { prefix: '/internal/imap' });

  return app;
}
