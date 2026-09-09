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
import { buildGoogleAuthUrl, exchangeGoogleCode, isGoogleOAuthConfigured } from '../lib/googleOAuth';
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  isMicrosoftOAuthConfigured,
} from '../lib/microsoftOAuth';
import { signOAuthState, verifyOAuthState, type OAuthStatePayload } from '../lib/oauthState';
import { encrypt, loadEncryptionKey } from '../lib/encryption';
import { requireAuth } from '../lib/requireAuth';

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
  // Dashboard-only, authenticated — unlike /:provider/authorize and /:provider/callback below,
  // which stay public (the provider itself calls back). Lets the Mailboxes page grey out
  // "Connect with Google/Microsoft" instead of leaving a button live that dead-ends into
  // `${provider}_not_configured`.
  app.get('/status', { preHandler: requireAuth }, async () => ({
    google: await isGoogleOAuthConfigured(),
    microsoft: await isMicrosoftOAuthConfigured(),
  }));

  app.get<{ Params: { provider: string }; Querystring: { mailboxId?: string } }>(
    '/:provider/authorize',
    async (request, reply) => {
      const { provider } = request.params;
      const { mailboxId } = request.query;
      if (!isSupportedProvider(provider) || !mailboxId) {
        return reply.code(422).send({ error: 'Unsupported provider or missing mailboxId' });
      }
      const state = signOAuthState({ mailboxId, provider: toDbProvider(provider) });
      let authUrl: string;
      try {
        authUrl =
          provider === 'google' ? await buildGoogleAuthUrl(state) : await buildMicrosoftAuthUrl(state);
      } catch (err) {
        // Thrown when this instance has no client id/secret configured for the provider yet
        // (blank by default in .env.example — every fresh install starts in this state). Without
        // this catch, the error escaped as a raw, unbranded 500 JSON body instead of the friendly
        // in-app toast every other failure path here already gets via redirectWithError(). The
        // mailbox row was already created by the dashboard's POST /mailboxes just before this
        // redirect, and never actually connects — remove it so a retry against the same email
        // isn't blocked by Mailbox.email's unique constraint.
        app.log.error(err, `[oauth] ${provider} is not configured on this instance`);
        await prisma.mailbox.delete({ where: { id: mailboxId } }).catch(() => null);
        return redirectWithError(reply, `${provider}_not_configured`);
      }
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

    try {
      // Moved inside the try (was a bare call before this fix) — same unguarded-crash class as
      // the /authorize route above: a missing MAILBOX_CREDENTIAL_KEY threw past this handler's
      // safety net entirely instead of degrading to the friendly redirectWithError() every other
      // failure here already gets.
      const encryptionKey = loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
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
