/**
 * Mailbox OAuth redirect URI resolution (2026-09-09) — replaces the old design where
 * GOOGLE_OAUTH_REDIRECT_URI/MICROSOFT_OAUTH_REDIRECT_URI were required `.env` vars every install
 * had to hand-type (and get exactly right, including the easy-to-miss `/v1` prefix — see this
 * repo's own history of that bug). A paid-tier customer should never need to touch `.env` at all;
 * `.env` is the Tier 0 (self-hosted core, no dashboard) configuration surface only.
 *
 * Priority, mirroring resolveGoogleOAuthCredentials/resolveMicrosoftOAuthCredentials's
 * DB-wins-over-env precedence for client id/secret:
 *   1. `OAuthClientConfig.redirectUriOverride` — dashboard-settable (Settings → Mailbox OAuth
 *      Apps), for the rare install behind a non-standard reverse proxy where the computed default
 *      isn't the real publicly-reachable URL. No `.env` edit, no restart.
 *   2. The env var — Tier 0's only configuration surface, and still usable as an ops-level escape
 *      hatch on any tier if someone prefers `.env` over the dashboard.
 *   3. Computed from WARMHAWK_DOMAIN — the common case (the shipped nginx.conf.template always
 *      serves `/v1/oauth/` at `https://${WARMHAWK_DOMAIN}/...`), needing zero configuration.
 */
import { prisma, type OAuthClientProvider } from '@warmhawk/db';

const ENV_VAR: Record<OAuthClientProvider, string> = {
  GOOGLE: 'GOOGLE_OAUTH_REDIRECT_URI',
  MICROSOFT: 'MICROSOFT_OAUTH_REDIRECT_URI',
};

const CALLBACK_PATH_SEGMENT: Record<OAuthClientProvider, string> = {
  GOOGLE: 'google',
  MICROSOFT: 'microsoft',
};

export function computeDefaultRedirectUri(provider: OAuthClientProvider): string | null {
  const domain = process.env.WARMHAWK_DOMAIN;
  if (!domain) return null;
  return `https://${domain}/v1/oauth/${CALLBACK_PATH_SEGMENT[provider]}/callback`;
}

export async function resolveRedirectUri(provider: OAuthClientProvider): Promise<string> {
  const dbRow = await prisma.oAuthClientConfig.findUnique({ where: { provider } });
  if (dbRow?.redirectUriOverride) return dbRow.redirectUriOverride;

  const envValue = process.env[ENV_VAR[provider]];
  if (envValue) return envValue;

  const computed = computeDefaultRedirectUri(provider);
  if (computed) return computed;

  throw new Error(
    `Can't resolve a redirect URI for ${provider}: no dashboard override, no ${ENV_VAR[provider]}, and WARMHAWK_DOMAIN isn't set either.`,
  );
}
