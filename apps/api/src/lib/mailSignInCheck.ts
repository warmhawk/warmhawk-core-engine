/**
 * Signs in to a mailbox's SMTP and IMAP servers once, before the mailbox is saved.
 *
 * Without this, a wrong password (or a Google Workspace / Microsoft 365 account that needs an app
 * password) saved fine and the dashboard said "Connected" — the first anyone heard of it was a
 * failed send hours later, or replies that never showed up because IMAP never signed in. Now the
 * person who typed the password sees what's wrong while the form is still open. The provider's own
 * text ("535-5.7.8 Username and Password not accepted", "NO [AUTHENTICATIONFAILED]") goes to the
 * log; the person gets a sentence.
 */
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

export type MailServerKind = 'SMTP' | 'IMAP';

export interface MailServerSignIn {
  host: string;
  port?: number;
  username: string;
  password: string;
}

export interface SignInRefusal {
  kind: MailServerKind;
  message: string;
  cause: unknown;
}

interface FailureShape {
  code?: string;
  responseCode?: number;
  authenticationFailed?: boolean;
}

/** Long enough for a slow provider, short enough that the form isn't left spinning. */
const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 15_000;

const DEFAULT_PORT: Record<MailServerKind, number> = { SMTP: 587, IMAP: 993 };
const USUAL_PORTS: Record<MailServerKind, string> = { SMTP: '587 or 465', IMAP: '993' };

export const SIGN_IN_REJECTED =
  "The mail server didn't accept that username and password. Google Workspace and Microsoft 365 usually need an app password here — or use Connect with Google or Connect with Microsoft instead.";

export const IMAP_SIGN_IN_REJECTED =
  "The IMAP server didn't accept that username and password, so WarmHawk couldn't read replies. Check the IMAP host — it usually takes the same password as SMTP.";

const DNS_CODES = new Set(['ENOTFOUND', 'EDNS', 'EAI_AGAIN']);
const CONNECT_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKET',
  'ETLS',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPROTO',
  // imapflow
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'ETIMEOUT',
  'NoConnection',
]);

/**
 * Hosts under the TLDs reserved for testing and documentation (RFC 2606 / RFC 6761) never resolve
 * on the public internet, so there's no server to sign in to. The test suites use them for
 * mailboxes that are never sent from; nobody's real mail server lives there.
 */
export function isReservedTestHost(host: string): boolean {
  return /\.(?:test|example|invalid)\.?$/i.test(host.trim());
}

function isConnectFailure(code: string): boolean {
  return CONNECT_CODES.has(code) || /^ERR_(?:TLS|SSL)_/.test(code);
}

/** The sentence for a failed sign-in check, from nodemailer's or imapflow's error. */
export function describeSignInFailure(
  error: unknown,
  kind: MailServerKind,
  host: string,
  port?: number,
): string {
  const failure = (error ?? {}) as FailureShape;
  const shownHost = host.trim().slice(0, 253);
  if (kind === 'IMAP' && failure.authenticationFailed) return IMAP_SIGN_IN_REJECTED;
  if (
    kind === 'SMTP' &&
    (failure.code === 'EAUTH' || failure.responseCode === 535 || failure.responseCode === 534)
  ) {
    return SIGN_IN_REJECTED;
  }
  if (failure.code && DNS_CODES.has(failure.code)) {
    return `We couldn't find a mail server called ${shownHost}. Check the ${kind} host.`;
  }
  if (failure.code && isConnectFailure(failure.code)) {
    return `We couldn't connect to ${shownHost} on port ${port ?? DEFAULT_PORT[kind]}. Check the ${kind} host and port — most mail servers use ${USUAL_PORTS[kind]}.`;
  }
  return `The ${kind} server at ${shownHost} didn't accept the sign-in. Check the ${kind} host, port, username and password.`;
}

/**
 * Null when the SMTP server accepted the sign-in (or the host is a reserved test name), otherwise
 * the sentence to show and the raw error to log.
 */
export async function checkSmtpSignIn(signIn: MailServerSignIn): Promise<SignInRefusal | null> {
  if (isReservedTestHost(signIn.host)) return null;

  // Built the way mailSender.ts builds its SMTP transport, so a pass here means sends will sign in.
  const clientName = process.env.WARMHAWK_DOMAIN?.trim();
  const transporter = nodemailer.createTransport({
    host: signIn.host.trim(),
    port: signIn.port,
    secure: signIn.port === 465,
    auth: { user: signIn.username, pass: signIn.password },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    ...(clientName ? { name: clientName } : {}),
  });

  try {
    await transporter.verify();
    return null;
  } catch (cause) {
    return {
      kind: 'SMTP',
      message: describeSignInFailure(cause, 'SMTP', signIn.host, signIn.port),
      cause,
    };
  } finally {
    transporter.close();
  }
}

/**
 * Null when the IMAP server accepted the sign-in (or the host is a reserved test name), otherwise
 * the sentence to show and the raw error to log. `secure` defaults to what imapClient.ts uses
 * (TLS on every port but 143); the tests turn it off to talk to a plain server on a random port.
 */
export async function checkImapSignIn(
  signIn: MailServerSignIn,
  { secure }: { secure?: boolean } = {},
): Promise<SignInRefusal | null> {
  if (isReservedTestHost(signIn.host)) return null;

  const port = signIn.port ?? DEFAULT_PORT.IMAP;
  // Built the way imapClient.ts opens a mailbox, so a pass here means replies can be read.
  const client = new ImapFlow({
    host: signIn.host.trim(),
    port,
    secure: secure ?? port !== 143,
    auth: { user: signIn.username, pass: signIn.password },
    logger: false,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
  // A socket error after connect() settled is reported as an event; unhandled, it would crash.
  client.on('error', () => undefined);

  try {
    await client.connect();
    await client.logout().catch(() => client.close());
    return null;
  } catch (cause) {
    client.close();
    return {
      kind: 'IMAP',
      message: describeSignInFailure(cause, 'IMAP', signIn.host, signIn.port),
      cause,
    };
  }
}

/**
 * Checks SMTP and IMAP side by side, so the form waits for the slower of the two, not both. A
 * refused SMTP sign-in is reported first — sending is what the mailbox is for.
 */
export async function checkMailboxSignIn(servers: {
  smtp?: MailServerSignIn;
  imap?: MailServerSignIn;
}): Promise<SignInRefusal | null> {
  const [smtp, imap] = await Promise.all([
    servers.smtp ? checkSmtpSignIn(servers.smtp) : null,
    servers.imap ? checkImapSignIn(servers.imap) : null,
  ]);
  return smtp ?? imap;
}
