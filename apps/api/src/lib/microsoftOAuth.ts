/**
 * Microsoft 365 OAuth mailbox-connect flow — genuinely NEW build (V11 Mailbox Connection
 * Upgrade): a Microsoft 365 mailbox previously had no path but raw username/password. This
 * mirrors `googleOAuth.ts`'s shape exactly — same
 * authorize-URL/exchange/mint-access-token trio, same encrypted-refresh-token storage pattern in
 * `oauthCallback.ts` — using the Microsoft identity platform's OAuth2 v2.0 endpoints directly
 * (no external SDK dependency, since `@azure/msal-node` would be the only reason to add one and
 * this repo's scope is one token exchange + one refresh call, both plain HTTPS POSTs).
 *
 * Requests `Mail.Send` + `IMAP.AccessAsUser.All` (delegated) scopes, per the spec.
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

const MICROSOFT_AUTHORIZE_ENDPOINT =
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/** Delegated scopes requested at consent time — `offline_access` is required to receive a
 *  refresh_token, matching Google's `access_type=offline` equivalent. */
export const MICROSOFT_OAUTH_SCOPES = [
  'offline_access',
  'https://outlook.office.com/Mail.Send',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
];

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

export async function buildMicrosoftAuthUrl(state: string): Promise<string> {
  const { clientId, redirectUri } = await resolveMicrosoftOAuthCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_OAUTH_SCOPES.join(' '),
    state,
  });
  return `${MICROSOFT_AUTHORIZE_ENDPOINT}?${params.toString()}`;
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
  fetchImpl: FetchLike = fetch,
): Promise<ExchangedMicrosoftTokens> {
  const { clientId, clientSecret, redirectUri } = await resolveMicrosoftOAuthCredentials();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    scope: MICROSOFT_OAUTH_SCOPES.join(' '),
  });

  const response = await fetchImpl(MICROSOFT_TOKEN_ENDPOINT, {
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
 *  expiry" UX contract as `mintGoogleAccessToken`. */
export async function mintMicrosoftAccessToken(
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const { clientId, clientSecret } = await resolveMicrosoftOAuthCredentials();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: MICROSOFT_OAUTH_SCOPES.join(' '),
  });

  const response = await fetchImpl(MICROSOFT_TOKEN_ENDPOINT, {
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
