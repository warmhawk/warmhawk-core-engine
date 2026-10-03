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
 *
 * WarmHawk Connect (09-27-26): when the owner hasn't registered their own OAuth app (BYO), and the
 * operator has pushed a license, `/authorize` sends the buyer through WarmHawk's shared app via the
 * relay on warmhawk.com instead (lib/connectRelay.ts), and the relay bounces the code to
 * `GET /oauth/:provider/connect-callback`. A BYO app, when set, always wins.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '@warmhawk/db';
import { buildGoogleAuthUrl, exchangeGoogleCode, isGoogleOAuthConfigured } from '../lib/googleOAuth';
import {
  buildMicrosoftAuthUrl,
  createPkcePair,
  exchangeMicrosoftCode,
  exchangeMicrosoftCodeConnect,
  fetchMicrosoftSignedInProfile,
  isMicrosoftOAuthConfigured,
  microsoftMailboxExists,
  MicrosoftTokenError,
} from '../lib/microsoftOAuth';
import {
  ConnectRelayError,
  exchangeGoogleCodeViaRelay,
  fetchConnectConfig,
  loadConnectLicense,
  startConnect,
} from '../lib/connectRelay';
import { signOAuthState, verifyOAuthState, type OAuthStatePayload } from '../lib/oauthState';
import { decrypt, encrypt, loadEncryptionKey } from '../lib/encryption';
import { requireAuth } from '../lib/requireAuth';
import { cleanProviderName, fetchGmailSendAsName } from '../lib/providerSenderName';

type DbProvider = OAuthStatePayload['provider'];
type RouteProvider = 'google' | 'microsoft';

function isSupportedProvider(value: string): value is RouteProvider {
  return value === 'google' || value === 'microsoft';
}

function toDbProvider(routeProvider: RouteProvider): DbProvider {
  return routeProvider === 'google' ? 'GOOGLE_WORKSPACE' : 'MICROSOFT_365';
}

/** The provider's display name as the mailbox's sender name — only when the owner hasn't typed
 *  one, so a reconnect never overwrites a name they chose. */
function senderNameFill(current: string | null, fromProvider: string | null) {
  return !current?.trim() && fromProvider ? { senderName: fromProvider } : {};
}

function dashboardUrl(): string {
  return process.env.DASHBOARD_APP_URL || 'http://localhost:4610';
}

function redirectWithError(reply: import('fastify').FastifyReply, reason: string, detail?: string) {
  const url = new URL('/dashboard/mailboxes', dashboardUrl());
  url.searchParams.set('oauth_error', reason);
  if (detail) url.searchParams.set('oauth_detail', detail);
  return reply.redirect(url.toString());
}

/** The provider's own explanation, trimmed to its first sentence — e.g. Microsoft's
 *  "AADSTS50194: Application '…' is not configured as a multi-tenant application." is exactly what
 *  the admin fixing the app registration needs, while the trace/correlation ids that follow it are
 *  noise in a toast. */
function providerErrorDetail(description: string | undefined): string | undefined {
  const firstSentence = description?.split(/(?<=\.)\s/)[0]?.trim();
  return firstSentence ? firstSentence.slice(0, 300) : undefined;
}

/** The dashboard's POST /mailboxes creates the row before the consent round trip. When that round
 *  trip fails, a row that never got a credential is removed — otherwise it lingers as a
 *  credential-less "WARMUP" mailbox that looks connected and blocks a retry on Mailbox.email's
 *  unique constraint. A mailbox that already holds a credential (a reconnect) is left alone. */
async function removeIfNeverConnected(mailboxId: string): Promise<void> {
  await prisma.mailbox
    .deleteMany({
      where: { id: mailboxId, oauthRefreshTokenEncrypted: null, authPasswordEncrypted: null },
    })
    .catch(() => null);
}

interface ProviderMode {
  via: 'BYO' | 'CONNECT';
  /** WarmHawk's public client id, for the operator's "trust WarmHawk" card. Null for BYO, and for
   *  Connect while the relay can't be asked. */
  connectClientId: string | null;
  /** Connect + Microsoft only: the relay page a Microsoft 365 admin opens to approve WarmHawk for
   *  their whole organization, so nobody there hits "Need admin approval" again. */
  adminConsentUrl: string | null;
}

/** BYO when the owner registered their own app; otherwise Connect when the operator has pushed a
 *  license and the relay hasn't switched this provider off; otherwise nothing. A relay that can't
 *  be asked right now still counts as on — `/authorize` then says it's unreachable, which is the
 *  truth, instead of greying the button out as "not set up". */
async function resolveProviderMode(provider: RouteProvider): Promise<ProviderMode | null> {
  const byo =
    provider === 'google' ? await isGoogleOAuthConfigured() : await isMicrosoftOAuthConfigured();
  if (byo) return { via: 'BYO', connectClientId: null, adminConsentUrl: null };
  const license = await loadConnectLicense().catch(() => null);
  if (!license) return null;
  const config = await fetchConnectConfig(license.relayBaseUrl);
  if (config && !config[provider]) return null;
  return {
    via: 'CONNECT',
    connectClientId: config?.[provider]?.clientId ?? null,
    adminConsentUrl:
      provider === 'microsoft' ? `${license.relayBaseUrl}/connect/microsoft/admin-consent` : null,
  };
}

/** The claims of a JWT, unverified. Only for Google's id_token, which comes straight from Google's
 *  token endpoint over TLS (through our relay), where OIDC doesn't require checking the signature. */
function decodeJwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Maps the provider's `error` on a Connect callback to the dashboard's error codes (design
 *  Section 9). */
function connectProviderError(
  provider: RouteProvider,
  error: string,
  description: string | undefined,
): { reason: string; detail?: string } {
  if (provider === 'google' && error === 'admin_policy_enforced') {
    return {
      reason: 'google_not_trusted',
      detail:
        "Your Google Workspace admin hasn't trusted WarmHawk yet. Ask them to add WarmHawk's client ID in admin.google.com (Security → API controls), then try again.",
    };
  }
  if (
    provider === 'microsoft' &&
    (error === 'consent_required' || /AADSTS(65001|90094)/.test(description ?? ''))
  ) {
    return {
      reason: 'ms_admin_required',
      detail: 'A Microsoft 365 admin in your organization has to approve WarmHawk once.',
    };
  }
  // Microsoft's "Need admin approval" screen has one way out — "Return to the application" — and it
  // comes back as a bare `access_denied` with no description. Someone who declines the consent
  // prompt themselves comes back with AADSTS65004 instead, so only that one is a plain cancel.
  if (
    provider === 'microsoft' &&
    error === 'access_denied' &&
    !/AADSTS65004/.test(description ?? '')
  ) {
    return {
      reason: 'ms_admin_required',
      detail:
        'Microsoft stopped the sign-in. If it said "Need admin approval", a Microsoft 365 admin in your organization has to approve WarmHawk once. If you cancelled, just click Connect again.',
    };
  }
  if (error === 'access_denied') return { reason: 'cancelled' };
  return { reason: `${provider}_rejected`, detail: providerErrorDetail(description) };
}

export async function oauthCallbackRoutes(app: FastifyInstance): Promise<void> {
  // Dashboard-only, authenticated — unlike /:provider/authorize and /:provider/callback below,
  // which stay public (the provider itself calls back). Lets the Mailboxes page grey out
  // "Connect with Google/Microsoft" instead of leaving a button live that dead-ends into
  // `${provider}_not_configured`.
  //
  // `google`/`microsoft` stay booleans (true when either BYO or Connect can connect one). `via`
  // says which, and `connectClientIds` carries WarmHawk's public client id per provider.
  app.get('/status', { preHandler: requireAuth }, async () => {
    const [google, microsoft] = await Promise.all([
      resolveProviderMode('google'),
      resolveProviderMode('microsoft'),
    ]);
    return {
      google: Boolean(google),
      microsoft: Boolean(microsoft),
      via: { google: google?.via ?? null, microsoft: microsoft?.via ?? null },
      connectClientIds: {
        google: google?.connectClientId ?? null,
        microsoft: microsoft?.connectClientId ?? null,
      },
      connectAdminConsentUrl: microsoft?.adminConsentUrl ?? null,
    };
  });

  app.get<{ Params: { provider: string }; Querystring: { mailboxId?: string } }>(
    '/:provider/authorize',
    async (request, reply) => {
      const { provider } = request.params;
      const { mailboxId } = request.query;
      if (!isSupportedProvider(provider) || !mailboxId) {
        return reply.code(422).send({ error: 'Unsupported provider or missing mailboxId' });
      }
      const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { email: true },
      });
      if (!mailbox) return redirectWithError(reply, 'mailbox_not_found');

      const mode = await resolveProviderMode(provider);
      if (mode?.via === 'CONNECT') {
        try {
          const pkce = provider === 'microsoft' ? createPkcePair() : null;
          const state = signOAuthState({
            mailboxId,
            provider: toDbProvider(provider),
            via: 'connect',
            ...(pkce
              ? {
                  pkv: encrypt(
                    pkce.verifier,
                    loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || ''),
                  ),
                }
              : {}),
          });
          const { authorizeUrl } = await startConnect({
            provider,
            installState: state,
            loginHint: mailbox.email,
            ...(pkce ? { codeChallenge: pkce.challenge } : {}),
          });
          return reply.redirect(authorizeUrl);
        } catch (err) {
          app.log.error(err, `[oauth] WarmHawk Connect start failed for provider=${provider}`);
          await removeIfNeverConnected(mailboxId);
          if (err instanceof ConnectRelayError) {
            return err.code === 'not_configured'
              ? redirectWithError(reply, `${provider}_not_configured`, err.detail)
              : redirectWithError(reply, err.code, err.detail);
          }
          return redirectWithError(reply, `${provider}_not_configured`);
        }
      }

      // BYO — or neither, which buildGoogleAuthUrl/buildMicrosoftAuthUrl turn into the
      // not-configured error below.
      const state = signOAuthState({ mailboxId, provider: toDbProvider(provider) });
      let authUrl: string;
      try {
        authUrl =
          provider === 'google'
            ? await buildGoogleAuthUrl(state)
            : await buildMicrosoftAuthUrl(state, mailbox.email);
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
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>('/:provider/callback', async (request, reply) => {
    const { provider } = request.params;
    const { code, state, error, error_description: errorDescription } = request.query;

    if (!isSupportedProvider(provider)) {
      return reply.code(404).send({ error: 'Unsupported provider' });
    }
    if (error) {
      // Only a signed state identifies a mailbox this flow created — never delete on an unsigned id.
      let failedMailboxId: string | undefined;
      try {
        if (state) ({ mailboxId: failedMailboxId } = verifyOAuthState(state));
      } catch {
        failedMailboxId = undefined;
      }
      if (failedMailboxId) await removeIfNeverConnected(failedMailboxId);
      // `access_denied` is the user declining consent. Anything else is the provider rejecting the
      // request itself (app registration, tenant policy) — reporting that as "denied" sent admins
      // looking at the wrong thing.
      return error === 'access_denied'
        ? redirectWithError(reply, `${provider}_denied`)
        : redirectWithError(reply, `${provider}_rejected`, providerErrorDetail(errorDescription));
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
      const mailboxRecord = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { email: true, senderName: true },
      });
      if (!mailboxRecord) {
        return redirectWithError(reply, 'mailbox_not_found');
      }
      if (provider === 'google') {
        const tokens = await exchangeGoogleCode(code);
        const providerName = tokens.accessToken
          ? await fetchGmailSendAsName(tokens.accessToken, mailboxRecord.email)
          : null;
        await prisma.mailbox.update({
          where: { id: mailboxId },
          data: {
            provider: 'GOOGLE_WORKSPACE',
            oauthVia: 'BYO',
            oauthClientId: null,
            oauthRefreshTokenEncrypted: encrypt(tokens.refreshToken, encryptionKey),
            oauthConnectedAt: new Date(),
            oauthScope: tokens.scope,
            // Both nodemailer auth branches in mailSender.ts build the SAME
            // `createTransport({ host, port, auth })` config regardless of credential type — OAuth2
            // mailboxes need these just as much as password mailboxes do, but the OAuth callback
            // never set them, so every OAuth-connected mailbox on every install could never send.
            smtpHost: 'smtp.gmail.com',
            smtpPort: 587,
            // Same gap on the read side: imapClient.ts's openImapClient() requires imapHost just as
            // unconditionally as mailSender.ts requires smtpHost, so no OAuth-connected mailbox
            // could ever have its replies polled either (imapPort needs no explicit value here —
            // the Prisma schema already defaults it to 993, correct for both providers).
            imapHost: 'imap.gmail.com',
            authUsername: mailboxRecord.email,
            connectionError: null,
            connectionErrorAt: null,
            ...senderNameFill(mailboxRecord.senderName, providerName),
          },
        });
      } else {
        // No sender name from here: this app's token is for Outlook IMAP/SMTP only, and adding
        // User.Read would send every BYO install back through admin consent. The dashboard asks.
        const tokens = await exchangeMicrosoftCode(code, mailboxRecord.email);
        await prisma.mailbox.update({
          where: { id: mailboxId },
          data: {
            provider: 'MICROSOFT_365',
            oauthVia: 'BYO',
            oauthClientId: null,
            oauthRefreshTokenEncrypted: encrypt(tokens.refreshToken, encryptionKey),
            oauthConnectedAt: new Date(),
            oauthScope: tokens.scope,
            smtpHost: 'smtp.office365.com',
            smtpPort: 587,
            imapHost: 'outlook.office365.com',
            authUsername: mailboxRecord.email,
            connectionError: null,
            connectionErrorAt: null,
          },
        });
      }
    } catch (err) {
      app.log.error(err, `[oauth] token exchange failed for provider=${provider}`);
      await removeIfNeverConnected(mailboxId);
      return redirectWithError(reply, 'token_exchange_failed');
    }

    const url = new URL('/dashboard/mailboxes', dashboardUrl());
    url.searchParams.set('connected', mailboxId);
    return reply.redirect(url.toString());
  });
  // WarmHawk Connect: the relay on warmhawk.com bounces the provider's code (or error) here, with
  // `state` set back to the install state /authorize signed. Google's code is exchanged by the
  // relay (it holds the secret); Microsoft's is exchanged here with the PKCE verifier.
  app.get<{
    Params: { provider: string };
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>('/:provider/connect-callback', async (request, reply) => {
    const { provider } = request.params;
    const { code, state, error, error_description: errorDescription } = request.query;
    if (!isSupportedProvider(provider)) {
      return reply.code(404).send({ error: 'Unsupported provider' });
    }

    let payload: OAuthStatePayload;
    try {
      payload = verifyOAuthState(state ?? '');
    } catch {
      return redirectWithError(reply, 'invalid_state');
    }
    if (payload.via !== 'connect' || payload.provider !== toDbProvider(provider)) {
      return redirectWithError(reply, 'invalid_state');
    }
    const { mailboxId } = payload;

    if (error) {
      await removeIfNeverConnected(mailboxId);
      const mapped = connectProviderError(provider, error, errorDescription);
      return redirectWithError(reply, mapped.reason, mapped.detail);
    }
    if (!code) {
      await removeIfNeverConnected(mailboxId);
      return redirectWithError(reply, 'missing_code_or_state');
    }

    try {
      const encryptionKey = loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
      const mailboxRecord = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { email: true, senderName: true },
      });
      if (!mailboxRecord) return redirectWithError(reply, 'mailbox_not_found');
      const wantedEmail = mailboxRecord.email.toLowerCase();

      if (provider === 'google') {
        const tokens = await exchangeGoogleCodeViaRelay(code);
        const claims = decodeJwtClaims(tokens.idToken);
        const signedInAs = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
        if (signedInAs !== wantedEmail || claims.email_verified === false) {
          // Give the grant back: nothing about the wrong account should stay authorized.
          await fetch(GOOGLE_REVOKE_URL, {
            method: 'POST',
            body: new URLSearchParams({ token: tokens.refreshToken }),
            signal: AbortSignal.timeout(5_000),
          }).catch(() => undefined);
          await removeIfNeverConnected(mailboxId);
          return redirectWithError(
            reply,
            'wrong_account',
            `You signed in to Google as ${signedInAs || 'a different account'}. Sign in as ${mailboxRecord.email} to connect it.`,
          );
        }
        const providerName = await fetchGmailSendAsName(tokens.accessToken, mailboxRecord.email);
        await prisma.mailbox.update({
          where: { id: mailboxId },
          data: {
            provider: 'GOOGLE_WORKSPACE',
            oauthVia: 'CONNECT',
            oauthClientId: typeof claims.aud === 'string' ? claims.aud : null,
            oauthRefreshTokenEncrypted: encrypt(tokens.refreshToken, encryptionKey),
            oauthConnectedAt: new Date(),
            oauthScope: tokens.scope,
            smtpHost: 'smtp.gmail.com',
            smtpPort: 587,
            imapHost: 'imap.gmail.com',
            authUsername: mailboxRecord.email,
            connectionError: null,
            connectionErrorAt: null,
            ...senderNameFill(mailboxRecord.senderName, providerName),
          },
        });
      } else {
        const license = await loadConnectLicense();
        const clientId = license
          ? (await fetchConnectConfig(license.relayBaseUrl))?.microsoft?.clientId
          : undefined;
        if (!license || !clientId || !payload.pkv) {
          throw new ConnectRelayError(
            'relay_unreachable',
            "Couldn't reach warmhawk.com. Try again in a minute.",
          );
        }
        const tokens = await exchangeMicrosoftCodeConnect({
          code,
          codeVerifier: decrypt(payload.pkv, encryptionKey),
          clientId,
          redirectUri: `${license.relayBaseUrl}/connect/microsoft/callback`,
        });
        const profile = await fetchMicrosoftSignedInProfile(tokens.accessToken);
        const { addresses } = profile;
        if (!addresses.includes(wantedEmail)) {
          await removeIfNeverConnected(mailboxId);
          return redirectWithError(
            reply,
            'wrong_account',
            `You signed in to Microsoft as ${addresses[0] ?? 'a different account'}. Sign in as ${mailboxRecord.email} to connect it.`,
          );
        }
        // A Microsoft 365 user without an Exchange Online license signs in fine but has no mailbox,
        // so every send would fail while the dashboard said "Connected". Catch it here instead.
        if (!(await microsoftMailboxExists(tokens.accessToken))) {
          await removeIfNeverConnected(mailboxId);
          return redirectWithError(
            reply,
            'ms_no_mailbox',
            `${mailboxRecord.email} signed in, but it has no Microsoft 365 mailbox yet — it needs an Exchange Online license. Assign one in the Microsoft 365 admin center, wait a few minutes, then connect again.`,
          );
        }
        await prisma.mailbox.update({
          where: { id: mailboxId },
          data: {
            provider: 'MICROSOFT_365',
            oauthVia: 'CONNECT',
            oauthClientId: clientId,
            oauthRefreshTokenEncrypted: encrypt(tokens.refreshToken, encryptionKey),
            oauthConnectedAt: new Date(),
            oauthScope: tokens.scope,
            smtpHost: 'smtp.office365.com',
            smtpPort: 587,
            imapHost: 'outlook.office365.com',
            authUsername: mailboxRecord.email,
            connectionError: null,
            connectionErrorAt: null,
            ...senderNameFill(
              mailboxRecord.senderName,
              cleanProviderName(profile.displayName, mailboxRecord.email),
            ),
          },
        });
      }
    } catch (err) {
      app.log.error(err, `[oauth] WarmHawk Connect callback failed for provider=${provider}`);
      await removeIfNeverConnected(mailboxId);
      if (err instanceof ConnectRelayError) return redirectWithError(reply, err.code, err.detail);
      if (
        err instanceof MicrosoftTokenError &&
        (err.error === 'consent_required' || /AADSTS(65001|90094)/.test(err.description))
      ) {
        const mapped = connectProviderError('microsoft', err.error, err.description);
        return redirectWithError(reply, mapped.reason, mapped.detail);
      }
      return redirectWithError(reply, 'token_exchange_failed');
    }

    const url = new URL('/dashboard/mailboxes', dashboardUrl());
    url.searchParams.set('connected', mailboxId);
    return reply.redirect(url.toString());
  });
}
