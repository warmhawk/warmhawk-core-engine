/**
 * Mailbox-connect friction reduction, Item 3 (2026-09-09) — lets an owner register their own
 * Google/Microsoft OAuth app's client id/secret in-app (`GET/POST/DELETE /oauth/client-config`)
 * instead of editing `.env` and restarting the stack. Mirrors `aiProviders.ts`'s shape exactly:
 * `requireAuth`-protected, `encrypt`/`decrypt`/`loadEncryptionKey`/`maskSecret` for the secret,
 * `upsert` keyed by provider. `googleOAuth.ts`/`microsoftOAuth.ts` read this table first and fall
 * back to env vars when no row exists — see `resolveGoogleOAuthCredentials`/
 * `resolveMicrosoftOAuthCredentials`.
 *
 * Redirect URI (revised 2026-09-09 — see oauthRedirectUri.ts's header comment for the full
 * precedence): this route shows the computed default (from this instance's own domain) so the
 * owner knows the exact value to register in Google Cloud Console / the Microsoft Entra admin
 * center, and lets them save an explicit override for the rare non-standard-reverse-proxy case —
 * still no `.env` edit or restart needed either way.
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type OAuthClientProvider } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { encrypt, decrypt, loadEncryptionKey, maskSecret } from '../lib/encryption';
import { computeDefaultRedirectUri } from '../lib/oauthRedirectUri';

interface SaveClientConfigBody {
  provider?: OAuthClientProvider;
  clientId?: string;
  clientSecret?: string;
  /** Omit/undefined leaves the existing override untouched; '' clears it back to the computed
   *  default; a non-empty string sets it. */
  redirectUriOverride?: string;
}

const PROVIDERS: OAuthClientProvider[] = ['GOOGLE', 'MICROSOFT'];

const REDIRECT_URI_ENV_VAR: Record<OAuthClientProvider, string> = {
  GOOGLE: 'GOOGLE_OAUTH_REDIRECT_URI',
  MICROSOFT: 'MICROSOFT_OAUTH_REDIRECT_URI',
};

const ENV_CLIENT_ID_VAR: Record<OAuthClientProvider, string> = {
  GOOGLE: 'GOOGLE_OAUTH_CLIENT_ID',
  MICROSOFT: 'MICROSOFT_OAUTH_CLIENT_ID',
};

const ENV_CLIENT_SECRET_VAR: Record<OAuthClientProvider, string> = {
  GOOGLE: 'GOOGLE_OAUTH_CLIENT_SECRET',
  MICROSOFT: 'MICROSOFT_OAUTH_CLIENT_SECRET',
};

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
}

/** The value that would actually be used right now, outside of a dashboard override — env var
 *  first (Tier 0 / ops escape hatch), else the computed default. Never throws: a route response
 *  needs a nullable "nothing resolvable yet" state, not an exception. */
function activeNonOverrideRedirectUri(provider: OAuthClientProvider): string | null {
  return process.env[REDIRECT_URI_ENV_VAR[provider]] || computeDefaultRedirectUri(provider);
}

export async function oauthClientConfigRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => {
    const rows = await prisma.oAuthClientConfig.findMany();
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    const key = encryptionKey();

    return PROVIDERS.map((provider) => {
      const fallbackRedirectUri = activeNonOverrideRedirectUri(provider);
      const dbRow = byProvider.get(provider);
      const redirectUri = dbRow?.redirectUriOverride || fallbackRedirectUri;
      if (dbRow) {
        return {
          provider,
          source: 'db' as const,
          configured: Boolean(redirectUri),
          clientId: dbRow.clientId,
          maskedClientSecret: maskSecret(decrypt(dbRow.clientSecretEncrypted, key)),
          redirectUri,
          redirectUriOverride: dbRow.redirectUriOverride,
          defaultRedirectUri: fallbackRedirectUri,
          updatedAt: dbRow.updatedAt,
        };
      }
      const envConfigured = Boolean(
        process.env[ENV_CLIENT_ID_VAR[provider]] && process.env[ENV_CLIENT_SECRET_VAR[provider]],
      );
      return {
        provider,
        source: envConfigured ? ('env' as const) : null,
        configured: envConfigured && Boolean(redirectUri),
        clientId: null,
        maskedClientSecret: null,
        redirectUri,
        redirectUriOverride: null,
        defaultRedirectUri: fallbackRedirectUri,
        updatedAt: null,
      };
    });
  });

  app.post<{ Body: SaveClientConfigBody }>('/', async (request, reply) => {
    const { provider, clientId, clientSecret, redirectUriOverride } = request.body;
    if (!provider || !PROVIDERS.includes(provider)) {
      return reply.code(422).send({ error: 'provider must be GOOGLE or MICROSOFT' });
    }
    if (!clientId?.trim() || !clientSecret?.trim()) {
      return reply.code(422).send({ error: 'clientId and clientSecret are required' });
    }

    const trimmedOverride = redirectUriOverride?.trim();
    const resolvedRedirectUri = trimmedOverride || activeNonOverrideRedirectUri(provider);
    if (!resolvedRedirectUri) {
      return reply.code(422).send({
        error: `Can't resolve a redirect URI for ${provider} — this instance has no WARMHAWK_DOMAIN set and no ${REDIRECT_URI_ENV_VAR[provider]} override. Fix the install's domain configuration before saving a client id/secret.`,
      });
    }

    const clientSecretEncrypted = encrypt(clientSecret.trim(), encryptionKey());
    // `redirectUriOverride === undefined` leaves an existing override untouched; '' clears it.
    const overrideUpdate =
      redirectUriOverride === undefined ? {} : { redirectUriOverride: trimmedOverride || null };
    const saved = await prisma.oAuthClientConfig.upsert({
      where: { provider },
      create: {
        provider,
        clientId: clientId.trim(),
        clientSecretEncrypted,
        redirectUriOverride: trimmedOverride || null,
      },
      update: { clientId: clientId.trim(), clientSecretEncrypted, ...overrideUpdate },
    });

    return reply.code(201).send({
      provider: saved.provider,
      source: 'db',
      configured: true,
      clientId: saved.clientId,
      maskedClientSecret: maskSecret(clientSecret.trim()),
      redirectUri: saved.redirectUriOverride || activeNonOverrideRedirectUri(provider),
      redirectUriOverride: saved.redirectUriOverride,
      defaultRedirectUri: activeNonOverrideRedirectUri(provider),
      updatedAt: saved.updatedAt,
    });
  });

  app.delete<{ Params: { provider: string } }>('/:provider', async (request, reply) => {
    const provider = request.params.provider as OAuthClientProvider;
    if (!PROVIDERS.includes(provider)) {
      return reply.code(422).send({ error: 'provider must be GOOGLE or MICROSOFT' });
    }
    const deleted = await prisma.oAuthClientConfig.delete({ where: { provider } }).catch(() => null);
    if (!deleted) return reply.code(404).send({ error: 'No client config saved for this provider' });
    // Falls back to env vars if set — same "doesn't break the campaign" pattern as
    // aiProviders.ts's DELETE, just for mailbox OAuth instead of AI personalization.
    return reply.code(204).send();
  });
}
