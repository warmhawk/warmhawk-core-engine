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

export const GMAIL_OAUTH_SCOPE = 'https://mail.google.com/';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function createGoogleOAuthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: requiredEnv('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: requiredEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    redirectUri: requiredEnv('GOOGLE_OAUTH_REDIRECT_URI'),
  });
}

export function buildGoogleAuthUrl(state: string): string {
  const client = createGoogleOAuthClient();
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
  const client = createGoogleOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token (missing access_type=offline or prompt=consent?)',
    );
  }
  return { refreshToken: tokens.refresh_token, scope: tokens.scope ?? null };
}

export async function mintGoogleAccessToken(refreshToken: string): Promise<string> {
  const client = createGoogleOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error('Failed to mint an access token from the stored refresh token');
  }
  return token;
}
