/**
 * Mailbox-connect friction reduction, Item 3 (2026-09-09) — lets an owner register their own
 * Google/Microsoft OAuth app's client id/secret in-app (`GET/POST/DELETE /oauth/client-config`)
 * instead of editing `.env` and restarting the stack. Mirrors `aiProviders.ts`'s shape exactly:
 * `requireAuth`-protected, `encrypt`/`decrypt`/`loadEncryptionKey`/`maskSecret` for the secret,
 * `upsert` keyed by provider. `googleOAuth.ts`/`microsoftOAuth.ts` read this table first and fall
 * back to env vars when no row exists — see `resolveGoogleOAuthCredentials`/
 * `resolveMicrosoftOAuthCredentials`.
 *
 * The redirect URI is deliberately NOT collected here — it's tied to the instance's own domain
 * (GOOGLE_OAUTH_REDIRECT_URI/MICROSOFT_OAUTH_REDIRECT_URI, set once at install time), not a
 * per-provider-app secret. This route surfaces it read-only so the owner knows the exact value to
 * register in Google Cloud Console / the Microsoft Entra admin center before saving credentials.
 */
import type { FastifyInstance } from 'fastify';
import { prisma, type OAuthClientProvider } from '@warmhawk/db';
import { requireAuth } from '../lib/requireAuth';
import { encrypt, decrypt, loadEncryptionKey, maskSecret } from '../lib/encryption';

interface SaveClientConfigBody {
  provider?: OAuthClientProvider;
  clientId?: string;
  clientSecret?: string;
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

export async function oauthClientConfigRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => {
    const rows = await prisma.oAuthClientConfig.findMany();
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    const key = encryptionKey();

    return PROVIDERS.map((provider) => {
      const redirectUri = process.env[REDIRECT_URI_ENV_VAR[provider]] || null;
      const dbRow = byProvider.get(provider);
      if (dbRow) {
        return {
          provider,
          source: 'db' as const,
          configured: Boolean(redirectUri),
          clientId: dbRow.clientId,
          maskedClientSecret: maskSecret(decrypt(dbRow.clientSecretEncrypted, key)),
          redirectUri,
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
        updatedAt: null,
      };
    });
  });

  app.post<{ Body: SaveClientConfigBody }>('/', async (request, reply) => {
    const { provider, clientId, clientSecret } = request.body;
    if (!provider || !PROVIDERS.includes(provider)) {
      return reply.code(422).send({ error: 'provider must be GOOGLE or MICROSOFT' });
    }
    if (!clientId?.trim() || !clientSecret?.trim()) {
      return reply.code(422).send({ error: 'clientId and clientSecret are required' });
    }
    if (!process.env[REDIRECT_URI_ENV_VAR[provider]]) {
      return reply.code(422).send({
        error: `${REDIRECT_URI_ENV_VAR[provider]} isn't set on this instance yet — set it to this instance's own domain (see the redirect URI shown in this same settings page) before saving a client id/secret.`,
      });
    }

    const clientSecretEncrypted = encrypt(clientSecret.trim(), encryptionKey());
    const saved = await prisma.oAuthClientConfig.upsert({
      where: { provider },
      create: { provider, clientId: clientId.trim(), clientSecretEncrypted },
      update: { clientId: clientId.trim(), clientSecretEncrypted },
    });

    return reply.code(201).send({
      provider: saved.provider,
      source: 'db',
      configured: true,
      clientId: saved.clientId,
      maskedClientSecret: maskSecret(clientSecret.trim()),
      redirectUri: process.env[REDIRECT_URI_ENV_VAR[provider]] || null,
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
