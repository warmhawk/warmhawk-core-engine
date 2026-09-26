/**
 * Microsoft 365 OAuth mailbox-connect flow — genuinely NEW build (V11 Mailbox Connection
 * Upgrade): a Microsoft 365 mailbox previously had no path but raw username/password. This
 * mirrors `googleOAuth.ts`'s shape exactly — same
 * authorize-URL/exchange/mint-access-token trio, same encrypted-refresh-token storage pattern in
 * `oauthCallback.ts` — using the Microsoft identity platform's OAuth2 v2.0 endpoints directly
 * (no external SDK dependency, since `@azure/msal-node` would be the only reason to add one and
 * this repo's scope is one token exchange + one refresh call, both plain HTTPS POSTs).
 *
 * Consents to Graph `Mail.Send` + `IMAP.AccessAsUser.All` (delegated). Sending goes through Graph
 * (`microsoftGraphTransport.ts`), not SMTP: SMTP AUTH is off by default on new Microsoft 365
 * tenants, so an SMTP-based send failed with `535 5.7.3` for any customer who hadn't had their IT
 * admin re-enable it per mailbox. Graph needs no tenant setting. IMAP stays on outlook.office.com.
 *
 * Every call goes to the mailbox's own tenant (`/{email-domain}/`), never `/common`. Entra's
 * default for a new app registration is "single tenant", and `/common` rejects those outright
 * (AADSTS50194) — so the app a customer registers by following the defaults could never connect.
 * A domain-addressed tenant endpoint works for single- and multi-tenant apps alike.
 *
 * IMPORTANT — this requires a Microsoft Entra app registration, an EXTERNAL dependency this repo
 * cannot create or verify on its own (blocked on a real Azure/Entra tenant + admin consent flow).
 * The code below is written against Microsoft's documented OAuth2 v2.0 token endpoint shape and
 * is exercised only against a stubbed/mocked HTTP boundary in tests — never a live call. See this
 * repo's build report for the explicit "blocked, external" note.
 */

import { prisma } from '@warmhawk/db';
import { decrypt, loadEncryptionKey } from './encryption';
import { resolveRedirectUri } from './oauthRedirectUri';

/** The tenant a mailbox signs in to, addressed by its email domain — Entra resolves any verified
 *  domain to its tenant, so no tenant id has to be collected from the customer. */
function tenantFor(email: string): string {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  if (!domain) throw new Error(`Cannot derive a Microsoft tenant from "${email}"`);
  return encodeURIComponent(domain);
}

function authorizeEndpoint(email: string): string {
  return `https://login.microsoftonline.com/${tenantFor(email)}/oauth2/v2.0/authorize`;
}

function tokenEndpoint(email: string): string {
  return `https://login.microsoftonline.com/${tenantFor(email)}/oauth2/v2.0/token`;
}

const GRAPH_MAIL_SEND_SCOPE = 'https://graph.microsoft.com/Mail.Send';
const IMAP_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All';

/** Delegated scopes requested at consent time — `offline_access` is required to receive a
 *  refresh_token, matching Google's `access_type=offline` equivalent. Consent may span both
 *  resources, but a token request may name only one, hence `scopeFor` below. */
export const MICROSOFT_OAUTH_SCOPES = ['offline_access', GRAPH_MAIL_SEND_SCOPE, IMAP_SCOPE];

/** Which resource an access token is minted for: `graph` to send, `imap` to read replies. */
export type MicrosoftTokenResource = 'graph' | 'imap';

function scopeFor(resource: MicrosoftTokenResource): string {
  return ['offline_access', resource === 'graph' ? GRAPH_MAIL_SEND_SCOPE : IMAP_SCOPE].join(' ');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

interface MicrosoftOAuthCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Mirrors `googleOAuth.ts`'s `resolveGoogleOAuthCredentials` — an in-app wizard-saved client
 *  id/secret (`OAuthClientConfig`, provider `MICROSOFT`) takes priority over
 *  MICROSOFT_OAUTH_CLIENT_ID/MICROSOFT_OAUTH_CLIENT_SECRET when present. Redirect URI resolution
 *  is shared with Google — see oauthRedirectUri.ts. */
async function resolveMicrosoftOAuthCredentials(): Promise<MicrosoftOAuthCredentials> {
  const redirectUri = await resolveRedirectUri('MICROSOFT');
  const dbConfig = await prisma.oAuthClientConfig.findUnique({ where: { provider: 'MICROSOFT' } });
  if (dbConfig) {
    const key = loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
    return {
      clientId: dbConfig.clientId,
      clientSecret: decrypt(dbConfig.clientSecretEncrypted, key),
      redirectUri,
    };
  }
  return {
    clientId: requiredEnv('MICROSOFT_OAUTH_CLIENT_ID'),
    clientSecret: requiredEnv('MICROSOFT_OAUTH_CLIENT_SECRET'),
    redirectUri,
  };
}

/** Cheap check for the dashboard's Mailboxes page — mirrors `googleOAuth.ts`'s
 *  `isGoogleOAuthConfigured`, including the same "don't also gate on the redirect URI" reasoning. */
export async function isMicrosoftOAuthConfigured(): Promise<boolean> {
  const dbConfig = await prisma.oAuthClientConfig.findUnique({ where: { provider: 'MICROSOFT' } });
  if (dbConfig) return true;
  return Boolean(process.env.MICROSOFT_OAUTH_CLIENT_ID && process.env.MICROSOFT_OAUTH_CLIENT_SECRET);
}

export async function buildMicrosoftAuthUrl(state: string, email: string): Promise<string> {
  const { clientId, redirectUri } = await resolveMicrosoftOAuthCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_OAUTH_SCOPES.join(' '),
    // Preselects the mailbox being connected, so a browser signed in to several Microsoft
    // accounts doesn't consent with the wrong one.
    login_hint: email,
    state,
  });
  return `${authorizeEndpoint(email)}?${params.toString()}`;
}

export interface ExchangedMicrosoftTokens {
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
  scope: string | null;
}

/** Injectable fetch implementation, so tests never make a real network call — mirrors the
 *  "mock/stub the actual provider call, don't make a real one" instruction applied throughout
 *  this repo's AI-provider and Stripe integrations. */
export type FetchLike = typeof fetch;

export async function exchangeMicrosoftCode(
  code: string,
  email: string,
  fetchImpl: FetchLike = fetch,
): Promise<ExchangedMicrosoftTokens> {
  const { clientId, clientSecret, redirectUri } = await resolveMicrosoftOAuthCredentials();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    scope: scopeFor('imap'),
  });

  const response = await fetchImpl(tokenEndpoint(email), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Microsoft token endpoint responded with ${response.status}`);
  }

  const json = (await response.json()) as {
    refresh_token?: string;
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!json.refresh_token || !json.access_token) {
    throw new Error(
      'Microsoft did not return a refresh_token/access_token (missing offline_access scope?)',
    );
  }

  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresInSeconds: json.expires_in ?? 3600,
    scope: json.scope ?? null,
  };
}

/** Mints a fresh access token from a stored refresh token — same "reconnect this mailbox on
 *  expiry" UX contract as `mintGoogleAccessToken`. One refresh token serves both resources. */
export async function mintMicrosoftAccessToken(
  refreshToken: string,
  email: string,
  resource: MicrosoftTokenResource,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const { clientId, clientSecret } = await resolveMicrosoftOAuthCredentials();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: scopeFor(resource),
  });

  const response = await fetchImpl(tokenEndpoint(email), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Microsoft token refresh responded with ${response.status}`);
  }

  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error('Microsoft token refresh did not return an access_token');
  }
  return json.access_token;
}
