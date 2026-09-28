/**
 * WarmHawk Connect (09-27-26) — this install's client for the relay on warmhawk.com. Design:
 * z-notes/2-design/09-26-26-warmhawk-connect.html, Sections 3–8.
 *
 * A self-hosted install lives on the buyer's own domain, but an OAuth app needs a fixed redirect
 * URI. So when the owner hasn't registered their own Google/Microsoft app (BYO), mailboxes connect
 * through WarmHawk's shared app instead: the relay signs the authorize URL, bounces the provider's
 * code back here, and — for Google only, since Google web clients need the client secret — does
 * the code exchange and every refresh. Microsoft is a public client with PKCE, so its tokens go
 * straight between this install and Microsoft (see microsoftOAuth.ts).
 *
 * The relay authenticates with the operator's license token, which the operator pushes here
 * (`PUT /v1/instance-settings/connect-license`). No license stored = Connect is off.
 */
import { prisma } from '@warmhawk/db';
import { decrypt, encrypt, loadEncryptionKey } from './encryption';

export type ConnectProvider = 'google' | 'microsoft';

export const DEFAULT_RELAY_BASE_URL = 'https://warmhawk.com';
const RELAY_TIMEOUT_MS = 10_000;
const CONFIG_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIG_FAILURE_TTL_MS = 60 * 1000;

export type FetchLike = typeof fetch;

/** Callback-redirect error codes (design Section 9) plus the ones only the relay can produce. */
export type ConnectErrorCode =
  | 'license'
  | 'relay_unreachable'
  | 'not_configured'
  | 'rate_limited'
  | 'scope_missing'
  | 'invalid_grant'
  | 'invalid_address'
  | 'exchange_failed';

export class ConnectRelayError extends Error {
  constructor(
    readonly code: ConnectErrorCode,
    /** Buyer-facing sentence for the dashboard toast (`oauth_detail`). */
    readonly detail: string,
  ) {
    super(`WarmHawk Connect: ${code} — ${detail}`);
    this.name = 'ConnectRelayError';
  }
}

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
}

// ---------------------------------------------------------------------------------------------
// The stored license
// ---------------------------------------------------------------------------------------------

export interface ConnectLicense {
  licenseToken: string;
  relayBaseUrl: string;
}

export async function loadConnectLicense(): Promise<ConnectLicense | null> {
  const settings = await prisma.instanceSettings.findUnique({
    where: { id: 'default' },
    select: { connectLicenseEncrypted: true, connectRelayBaseUrl: true },
  });
  if (!settings?.connectLicenseEncrypted) return null;
  return {
    licenseToken: decrypt(settings.connectLicenseEncrypted, encryptionKey()),
    relayBaseUrl: settings.connectRelayBaseUrl || DEFAULT_RELAY_BASE_URL,
  };
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/** The relay's origin, or null when the value isn't a bare https origin (plain http only for a
 *  local relay). The license is sent to this host, so nothing looser is accepted. */
export function normalizeRelayBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const protocolOk =
    url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url.hostname));
  if (!protocolOk || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

export async function saveConnectLicense(
  licenseToken: string,
  relayBaseUrl: string,
): Promise<void> {
  const data = {
    connectLicenseEncrypted: encrypt(licenseToken, encryptionKey()),
    connectRelayBaseUrl: relayBaseUrl,
  };
  await prisma.instanceSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...data },
    update: data,
  });
  configCache.clear();
}

/** Where the relay sends the buyer back to. Must equal what the relay accepts for this license's
 *  bound domain: `https://<WARMHAWK_DOMAIN>/v1/oauth/<provider>/connect-callback`. */
export function connectReturnUrl(provider: ConnectProvider): string {
  const domain = process.env.WARMHAWK_DOMAIN;
  if (!domain) throw new Error('WARMHAWK_DOMAIN is not set');
  const scheme = isLocalHost(domain) ? 'http' : 'https';
  return `${scheme}://${domain}/v1/oauth/${provider}/connect-callback`;
}

// ---------------------------------------------------------------------------------------------
// Relay calls
// ---------------------------------------------------------------------------------------------

interface RelayResponse {
  status: number;
  json: Record<string, unknown>;
}

const UNREACHABLE_DETAIL = "Couldn't reach warmhawk.com. Try again in a minute.";

async function relayPost(
  license: ConnectLicense,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: FetchLike,
): Promise<RelayResponse> {
  let response: Response;
  try {
    response = await fetchImpl(`${license.relayBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${license.licenseToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectRelayError('relay_unreachable', UNREACHABLE_DETAIL);
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

/** The error answers every relay route shares: license, config, rate limit, outage. `fallback`
 *  is what the calling route says about anything else — it names the step that failed, so a
 *  Microsoft connect never reads "Google turned down the sign-in". */
function commonRelayError({ status, json }: RelayResponse, fallback: string): ConnectRelayError {
  const error = typeof json.error === 'string' ? json.error : '';
  if (status === 402 || error === 'license_expired') {
    return new ConnectRelayError(
      'license',
      'Your WarmHawk license has expired. Renew it at warmhawk.com/account/billing, or connect this mailbox with an app password.',
    );
  }
  if (status === 403 || error === 'domain_mismatch') {
    const bound = typeof json.boundDomain === 'string' ? json.boundDomain : 'another server';
    return new ConnectRelayError(
      'license',
      `This license is tied to ${bound}. Moved servers? Email support@warmhawk.com.`,
    );
  }
  if (status === 409 || error === 'license_unbound') {
    return new ConnectRelayError(
      'license',
      "This install's license isn't linked to its domain yet. Open Settings → License, refresh it, then try again.",
    );
  }
  if (status === 401 || error === 'license_invalid') {
    return new ConnectRelayError(
      'license',
      "warmhawk.com couldn't verify this install's license. Check Settings → License.",
    );
  }
  if (status === 429) {
    return new ConnectRelayError(
      'rate_limited',
      'Too many connect attempts today. Try again tomorrow, or email support@warmhawk.com.',
    );
  }
  if (status === 503 && error === 'provider_not_configured') {
    return new ConnectRelayError(
      'not_configured',
      'WarmHawk Connect is switched off for this provider right now. Use an app password instead.',
    );
  }
  if (status >= 500) return new ConnectRelayError('relay_unreachable', UNREACHABLE_DETAIL);
  return new ConnectRelayError('exchange_failed', fallback);
}

async function requireLicense(): Promise<ConnectLicense> {
  const license = await loadConnectLicense();
  if (!license) {
    throw new ConnectRelayError(
      'license',
      'WarmHawk Connect needs an active license. Open Settings → License.',
    );
  }
  return license;
}

export interface StartConnectInput {
  provider: ConnectProvider;
  installState: string;
  loginHint: string;
  /** Microsoft only: the S256 PKCE challenge. */
  codeChallenge?: string;
}

export interface StartedConnect {
  authorizeUrl: string;
  clientId: string;
}

export async function startConnect(
  input: StartConnectInput,
  fetchImpl: FetchLike = fetch,
): Promise<StartedConnect> {
  const license = await requireLicense();
  const response = await relayPost(
    license,
    '/api/connect/start',
    {
      provider: input.provider,
      returnUrl: connectReturnUrl(input.provider),
      installState: input.installState,
      loginHint: input.loginHint,
      ...(input.codeChallenge ? { codeChallenge: input.codeChallenge } : {}),
    },
    fetchImpl,
  );
  const { authorizeUrl, clientId } = response.json;
  if (response.status === 200 && typeof authorizeUrl === 'string' && typeof clientId === 'string') {
    return { authorizeUrl, clientId };
  }
  // The relay checks the login hint is a whole address; a local part alone ("sales") fails here.
  if (response.status === 400 && response.json.error === 'invalid_request') {
    throw new ConnectRelayError(
      'invalid_address',
      `"${input.loginHint}" isn't a complete email address. Enter it as name@yourdomain.com and connect again.`,
    );
  }
  throw commonRelayError(
    response,
    "warmhawk.com couldn't start the sign-in. Click Connect to try again.",
  );
}

export interface RelayGoogleTokens {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
  idToken: string;
  scope: string | null;
}

/** Google's token response, passed through by the relay. `scope_missing` is the relay's own
 *  answer when the buyer didn't tick the Gmail box; it has already revoked the grant. */
export async function exchangeGoogleCodeViaRelay(
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<RelayGoogleTokens> {
  const license = await requireLicense();
  const response = await relayPost(
    license,
    '/api/connect/google/token',
    { grant: 'code', code },
    fetchImpl,
  );
  const { json } = response;
  if (response.status === 400 && json.error === 'scope_missing') {
    throw new ConnectRelayError(
      'scope_missing',
      'Google needs the box next to "Read, compose, send and permanently delete all your email from Gmail" ticked. Click Connect again and tick it.',
    );
  }
  if (response.status !== 200) {
    throw commonRelayError(response, 'Google turned down the sign-in. Click Connect to try again.');
  }
  if (
    typeof json.access_token !== 'string' ||
    typeof json.refresh_token !== 'string' ||
    typeof json.id_token !== 'string'
  ) {
    throw new ConnectRelayError(
      'exchange_failed',
      "Google didn't return everything WarmHawk needs. Click Connect to try again.",
    );
  }
  return {
    accessToken: json.access_token,
    expiresInSeconds: typeof json.expires_in === 'number' ? json.expires_in : 3600,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    scope: typeof json.scope === 'string' ? json.scope : null,
  };
}

export async function refreshGoogleViaRelay(
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const license = await requireLicense();
  const response = await relayPost(
    license,
    '/api/connect/google/token',
    { grant: 'refresh', refreshToken },
    fetchImpl,
  );
  const { json } = response;
  if (response.status === 400 && json.error === 'invalid_grant') {
    throw new ConnectRelayError(
      'invalid_grant',
      'Google no longer accepts this mailbox’s sign-in (password reset or access removed). Reconnect it.',
    );
  }
  if (response.status !== 200) {
    throw commonRelayError(
      response,
      'Google refused to refresh this mailbox’s sign-in. Try again, or reconnect it.',
    );
  }
  if (typeof json.access_token !== 'string') {
    throw new ConnectRelayError('exchange_failed', 'Google refresh returned no access token.');
  }
  return {
    accessToken: json.access_token,
    expiresInSeconds: typeof json.expires_in === 'number' ? json.expires_in : 3600,
  };
}

// ---------------------------------------------------------------------------------------------
// Public client ids (GET /api/connect/config)
// ---------------------------------------------------------------------------------------------

export interface ConnectConfig {
  google: { clientId: string } | null;
  microsoft: { clientId: string } | null;
}

const configCache = new Map<string, { value: ConnectConfig | null; expiresAt: number }>();

/** Which providers the relay has switched on, and their public client ids. `null` = the relay
 *  couldn't be asked just now; callers treat that as "unknown", not "off". */
export async function fetchConnectConfig(
  relayBaseUrl: string,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<ConnectConfig | null> {
  const cached = configCache.get(relayBaseUrl);
  if (cached && cached.expiresAt > now()) return cached.value;

  let value: ConnectConfig | null = null;
  try {
    const response = await fetchImpl(`${relayBaseUrl}/api/connect/config`, {
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    if (response.ok) {
      const json = (await response.json()) as Record<string, unknown>;
      value = { google: clientEntry(json.google), microsoft: clientEntry(json.microsoft) };
    }
  } catch {
    value = null;
  }
  configCache.set(relayBaseUrl, {
    value,
    expiresAt: now() + (value ? CONFIG_TTL_MS : CONFIG_FAILURE_TTL_MS),
  });
  return value;
}

function clientEntry(raw: unknown): { clientId: string } | null {
  const clientId = (raw as { clientId?: unknown } | null)?.clientId;
  return typeof clientId === 'string' && clientId ? { clientId } : null;
}

export function clearConnectConfigCache(): void {
  configCache.clear();
}
