/**
 * "Needs reconnect" — whether a mailbox's provider still accepts its sign-in.
 *
 * A connected mailbox can stop working without anyone touching WarmHawk: an admin removes
 * WarmHawk's approval, the user resets their password, the Microsoft 365 account never had a
 * mailbox. Nothing about the row changes, so the dashboard kept saying "Connected" while every
 * send failed. `sendMail()` and `openImapClient()` report their failures here; the ones that only
 * a reconnect fixes are stored on `Mailbox.connectionError` as the buyer-facing reason, and the
 * next successful send (or a reconnect, in oauthCallback.ts) clears it.
 *
 * Everything else — timeouts, rate limits, a recipient's server refusing one message — is left
 * alone, because reconnecting wouldn't fix it.
 */
import { prisma } from '@warmhawk/db';
import { ConnectRelayError } from './connectRelay';
import { MicrosoftTokenError } from './microsoftOAuth';

const MICROSOFT_APPROVAL_REMOVED =
  'Microsoft no longer has approval for WarmHawk on this mailbox. Reconnect it — if Microsoft asks for admin approval, a Microsoft 365 admin has to approve WarmHawk again.';
const MICROSOFT_SIGN_IN_REJECTED =
  "Microsoft no longer accepts this mailbox's sign-in (approval removed, password changed or account disabled). Reconnect it.";
const MICROSOFT_NO_MAILBOX =
  'This Microsoft 365 account has no mailbox — it needs an Exchange Online license. Assign one in the Microsoft 365 admin center, wait a few minutes, then reconnect.';
const GOOGLE_SIGN_IN_REJECTED =
  "Google no longer accepts this mailbox's sign-in (password reset or access removed). Reconnect it.";
const SERVER_SIGN_IN_REJECTED =
  "The mail server rejected this mailbox's sign-in. Reconnect it, or add it again with a new app password.";

interface FailureShape {
  message?: string;
  responseCode?: number;
  code?: string;
  authenticationFailed?: boolean;
  response?: { data?: { error?: unknown } };
}

/** The buyer-facing reason when `err` means the mailbox has to be reconnected, else null. */
export function connectionErrorFor(err: unknown): string | null {
  if (err instanceof ConnectRelayError) {
    return err.code === 'invalid_grant' ? GOOGLE_SIGN_IN_REJECTED : null;
  }
  if (err instanceof MicrosoftTokenError) {
    if (err.error === 'consent_required' || /AADSTS(65001|90094)/.test(err.description)) {
      return MICROSOFT_APPROVAL_REMOVED;
    }
    if (err.error === 'invalid_grant' || err.error === 'interaction_required') {
      return MICROSOFT_SIGN_IN_REJECTED;
    }
    return null;
  }

  const failure = (err ?? {}) as FailureShape;
  // Microsoft Graph sendMail (microsoftGraphTransport.ts sets `code` to Graph's error code).
  if (failure.code === 'MailboxNotEnabledForRESTAPI') return MICROSOFT_NO_MAILBOX;
  if (failure.code === 'InvalidAuthenticationToken' || failure.code === 'ErrorAccessDenied') {
    return MICROSOFT_SIGN_IN_REJECTED;
  }
  // Google's own OAuth client (BYO) refusing the stored refresh token.
  if (failure.response?.data?.error === 'invalid_grant') return GOOGLE_SIGN_IN_REJECTED;
  // SMTP AUTH (nodemailer: EAUTH / 535) and IMAP AUTHENTICATE (imapflow: authenticationFailed).
  if (failure.code === 'EAUTH' || failure.responseCode === 535 || failure.authenticationFailed) {
    return SERVER_SIGN_IN_REJECTED;
  }
  return null;
}

/** Marks the mailbox "needs reconnect" when `err` is that kind of failure. Never throws — the
 *  caller is already handling a failure and must see its own error, not this bookkeeping's. */
export async function recordConnectionFailure(mailboxId: string, err: unknown): Promise<void> {
  const reason = connectionErrorFor(err);
  if (!reason) return;
  await prisma.mailbox
    .update({
      where: { id: mailboxId },
      data: { connectionError: reason, connectionErrorAt: new Date() },
    })
    .catch(() => undefined);
}

/** Clears "needs reconnect" after the provider accepted the mailbox again. */
export async function clearConnectionFailure(mailboxId: string): Promise<void> {
  await prisma.mailbox
    .update({
      where: { id: mailboxId },
      data: { connectionError: null, connectionErrorAt: null },
    })
    .catch(() => undefined);
}
