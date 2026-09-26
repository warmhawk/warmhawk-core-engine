/**
 * nodemailer transport that sends a Microsoft 365 OAuth mailbox's mail through Microsoft Graph
 * (`POST /me/sendMail`) instead of SMTP.
 *
 * Why not SMTP XOAUTH2: SMTP AUTH is disabled by default on new Microsoft 365 tenants and has to be
 * re-enabled per mailbox by an Exchange admin — a setting most buyers' IT won't touch. Graph needs
 * nothing beyond the user's own `Mail.Send` consent.
 *
 * Why MIME rather than Graph's JSON message: the JSON form only accepts `x-` custom headers, which
 * would silently drop `List-Unsubscribe`/`List-Unsubscribe-Post` (RFC 8058). The MIME form sends the
 * message exactly as nodemailer composed it — same headers, same Message-ID — so everything
 * `mailSender.ts` builds reaches the recipient unchanged, on the same `transporter.sendMail` call it
 * already makes for SMTP.
 */
import type { Transport, SentMessageInfo } from 'nodemailer';
import type MailMessage from 'nodemailer/lib/mailer/mail-message';

const GRAPH_SEND_MAIL_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';

/** Shaped like nodemailer's SMTP errors, so `mailSender.ts` classifies a Graph failure the same way. */
export class GraphSendError extends Error {
  responseCode: number;
  code?: string;
  constructor(message: string, responseCode: number, code?: string) {
    super(message);
    this.responseCode = responseCode;
    this.code = code;
  }
}

export function createGraphTransport(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Transport<SentMessageInfo> {
  return {
    name: 'MicrosoftGraph',
    version: '1.0.0',
    send(mail: MailMessage, callback: (err: Error | null, info: SentMessageInfo) => void) {
      // Graph reads recipients from the MIME headers, so Bcc (seed-inbox placement BCCs) must stay
      // in — nodemailer strips it by default because SMTP carries it in the envelope instead.
      mail.message.keepBcc = true;
      const envelope = mail.message.getEnvelope();
      const messageId = mail.message.messageId();

      mail.message.build(async (buildErr, raw) => {
        if (buildErr) return callback(buildErr, undefined as unknown as SentMessageInfo);
        try {
          const response = await fetchImpl(GRAPH_SEND_MAIL_URL, {
            method: 'POST',
            headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'text/plain' },
            body: raw.toString('base64'),
          });
          if (!response.ok) {
            const detail = (await response.json().catch(() => null)) as {
              error?: { code?: string; message?: string };
            } | null;
            const code = detail?.error?.code;
            const message = detail?.error?.message ?? `Microsoft Graph sendMail responded with ${response.status}`;
            return callback(
              new GraphSendError(code ? `${code}: ${message}` : message, response.status, code),
              undefined as unknown as SentMessageInfo,
            );
          }
          callback(null, { envelope, messageId });
        } catch (err) {
          callback(err as Error, undefined as unknown as SentMessageInfo);
        }
      });
    },
  };
}
