/**
 * Mailbox OAuth connect flow — Google Workspace, extended, V11, with the Microsoft 365 equivalent
 * (`microsoftOAuth.ts`), wired into the SAME callback handler pattern per the spec ("wiring
 * MICROSOFT_365 into the same oauthCallback.ts handler pattern already proven for Google").
 *
 * `GET /oauth/:provider/authorize?mailboxId=` — starts the consent flow (dashboard's
 * "Connect with Google"/"Connect with Microsoft" buttons redirect here).
 * `GET /oauth/:provider/callback` — provider redirects back here with `code`+`state`; on success,
 * stores an AES-256-GCM-encrypted refresh token and redirects to the dashboard's mailboxes page.
 * Public endpoints (the provider itself calls back here) — no requireAuth, protected instead by
 * the signed `state` param.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { buildGoogleAuthUrl, exchangeGoogleCode } from '../lib/googleOAuth';
import { buildMicrosoftAuthUrl, exchangeMicrosoftCode } from '../lib/microsoftOAuth';
import { signOAuthState, verifyOAuthState, type OAuthStatePayload } from '../lib/oauthState';
import { encrypt, loadEncryptionKey } from '../lib/encryption';

type DbProvider = OAuthStatePayload['provider'];
type RouteProvider = 'google' | 'microsoft';

function isSupportedProvider(value: string): value is RouteProvider {
  return value === 'google' || value === 'microsoft';
}

function toDbProvider(routeProvider: RouteProvider): DbProvider {
  return routeProvider === 'google' ? 'GOOGLE_WORKSPACE' : 'MICROSOFT_365';
}

function dashboardUrl(): string {
  return process.env.DASHBOARD_APP_URL || 'http://localhost:4610';
}

function redirectWithError(reply: import('fastify').FastifyReply, reason: string) {
  const url = new URL('/dashboard/mailboxes', dashboardUrl());
  url.searchParams.set('oauth_error', reason);
  return reply.redirect(url.toString());
}

export async function oauthCallbackRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { provider: string }; Querystring: { mailboxId?: string } }>(
    '/:provider/authorize',
    async (request, reply) => {
      const { provider } = request.params;
      const { mailboxId } = request.query;
      if (!isSupportedProvider(provider) || !mailboxId) {
        return reply.code(422).send({ error: 'Unsupported provider or missing mailboxId' });
      }
      const state = signOAuthState({ mailboxId, provider: toDbProvider(provider) });
      const authUrl =
        provider === 'google' ? buildGoogleAuthUrl(state) : buildMicrosoftAuthUrl(state);
      return reply.redirect(authUrl);
    },
  );

  app.get<{
    Params: { provider: string };
    Querystring: { code?: string; state?: string; error?: string };
  }>('/:provider/callback', async (request, reply) => {
    const { provider } = request.params;
    const { code, state, error } = request.query;

    if (!isSupportedProvider(provider)) {
      return reply.code(404).send({ error: 'Unsupported provider' });
    }
    if (error) {
      return redirectWithError(reply, `${provider}_denied`);
    }
    if (!code || !state) {
      return redirectWithError(reply, 'missing_code_or_state');
    }

    let mailboxId: string;
    try {
      ({ mailboxId } = verifyOAuthState(state));
    } catch {
      return redirectWithError(reply, 'invalid_state');
    }

    const encryptionKey = loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');

    try {
      if (provider === 'google') {
        const tokens = await exchangeGoogleCode(code);
        await prisma.mailbox.update({
          where: { id: mailboxId },
          data: {
            provider: 'GOOGLE_WORKSPACE',
            oauthRefreshTokenEncrypted: encrypt(tokens.refreshToken, encryptionKey),
            oauthConnectedAt: new Date(),
            oauthScope: tokens.scope,
          },
        });
      } else {
        const tokens = await exchangeMicrosoftCode(code);
        await prisma.mailbox.update({
          where: { id: mailboxId },
          data: {
            provider: 'MICROSOFT_365',
            oauthRefreshTokenEncrypted: encrypt(tokens.refreshToken, encryptionKey),
            oauthConnectedAt: new Date(),
            oauthScope: tokens.scope,
          },
        });
      }
    } catch (err) {
      app.log.error(err, `[oauth] token exchange failed for provider=${provider}`);
      return redirectWithError(reply, 'token_exchange_failed');
    }

    const url = new URL('/dashboard/mailboxes', dashboardUrl());
    url.searchParams.set('connected', mailboxId);
    return reply.redirect(url.toString());
  });
}
