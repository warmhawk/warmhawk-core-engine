/**
 * Google Workspace OAuth mailbox-connect flow (Mailbox Connection Upgrade, V11): stores an
 * AES-256-GCM-encrypted refresh token, never a raw password, and authenticates over IMAP using
 * XOAUTH2.
 *
 * IMPORTANT — re-verification note (Phase 1/3-4, per the spec): the OAuth consent screen/app used
 * here needs its own Google verification (CASA third-party security assessment for the
 * `https://mail.google.com/` sensitive scope) under the WarmHawk brand — a rebrand typically means
 * a new app registration, so no existing verified app carries over automatically. This is
 * external, weeks-long, and explicitly NOT a Go-Live blocker (SMTP/IMAP password remains the
 * universal fallback) — start it early (Phase 3/4), track it separately.
 */
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '@warmhawk/db';
import { decrypt, loadEncryptionKey } from './encryption';

export const GMAIL_OAUTH_SCOPE = 'https://mail.google.com/';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Friction-reduction (2026-09-09) — an owner's own client id/secret entered via the in-app
 * Settings wizard (`OAuthClientConfig`, provider `GOOGLE`) takes priority over
 * GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET when present, so saving it in-app works
 * without an env edit + container restart. The redirect URI stays env-only regardless — it's tied
 * to the instance's own domain (set once at install time), not a per-provider-app secret the
 * wizard collects.
 */
async function resolveGoogleOAuthCredentials(): Promise<GoogleOAuthCredentials> {
  const redirectUri = requiredEnv('GOOGLE_OAUTH_REDIRECT_URI');
  const dbConfig = await prisma.oAuthClientConfig.findUnique({ where: { provider: 'GOOGLE' } });
  if (dbConfig) {
    const key = loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
    return {
      clientId: dbConfig.clientId,
      clientSecret: decrypt(dbConfig.clientSecretEncrypted, key),
      redirectUri,
    };
  }
  return {
    clientId: requiredEnv('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: requiredEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    redirectUri,
  };
}

/** Cheap check for the dashboard's Mailboxes page — lets it grey out "Connect with Google"
 *  instead of leaving it clickable into the `${provider}_not_configured` dead end. Configured via
 *  either the in-app wizard (DB) or env vars — the redirect URI is required either way. */
export async function isGoogleOAuthConfigured(): Promise<boolean> {
  if (!process.env.GOOGLE_OAUTH_REDIRECT_URI) return false;
  const dbConfig = await prisma.oAuthClientConfig.findUnique({ where: { provider: 'GOOGLE' } });
  if (dbConfig) return true;
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export async function createGoogleOAuthClient(): Promise<OAuth2Client> {
  const { clientId, clientSecret, redirectUri } = await resolveGoogleOAuthCredentials();
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

export async function buildGoogleAuthUrl(state: string): Promise<string> {
  const client = await createGoogleOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline', // required to receive a refresh_token
    prompt: 'consent', // force re-consent so a refresh_token is issued even on reconnect
    scope: [GMAIL_OAUTH_SCOPE],
    state,
  });
}

export interface ExchangedGoogleTokens {
  refreshToken: string;
  scope: string | null;
}

export async function exchangeGoogleCode(code: string): Promise<ExchangedGoogleTokens> {
  const client = await createGoogleOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token (missing access_type=offline or prompt=consent?)',
    );
  }
  return { refreshToken: tokens.refresh_token, scope: tokens.scope ?? null };
}

export async function mintGoogleAccessToken(refreshToken: string): Promise<string> {
  const client = await createGoogleOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error('Failed to mint an access token from the stored refresh token');
  }
  return token;
}
