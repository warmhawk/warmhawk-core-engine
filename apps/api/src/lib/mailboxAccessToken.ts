/**
 * One place that turns an OAuth mailbox's stored refresh token into an access token, for sending
 * (mailSender.ts) and reading (imapClient.ts). A refresh has to go back to the client that minted
 * the grant, so this branches on `Mailbox.oauthVia` (design Section 8, "Who mints the access
 * token"):
 *
 *   Google    BYO      the instance's own app and secret (googleOAuth.ts) — unchanged
 *   Google    CONNECT  the relay on warmhawk.com, which holds WarmHawk's secret
 *   Microsoft BYO      the instance's own app and secret (microsoftOAuth.ts) — unchanged
 *   Microsoft CONNECT  Microsoft directly, as WarmHawk's public client (no secret)
 *
 * Connect tokens are cached (accessTokenCache.ts), since each one is a network round trip.
 */
import { prisma, type Mailbox } from '@warmhawk/db';
import { decrypt, encrypt, loadEncryptionKey } from './encryption';
import { mintGoogleAccessToken } from './googleOAuth';
import { mintMicrosoftAccessToken, refreshMicrosoftConnectToken } from './microsoftOAuth';
import { refreshGoogleViaRelay } from './connectRelay';
import { accessTokenCacheKey, cachedAccessToken } from './accessTokenCache';

export type OAuthMailbox = Pick<
  Mailbox,
  'id' | 'email' | 'provider' | 'oauthVia' | 'oauthClientId' | 'oauthConnectedAt'
> & { oauthRefreshTokenEncrypted: string };

/** `send` is SMTP XOAUTH2 for Google and Graph for Microsoft; `imap` is IMAP XOAUTH2 for both. */
export type MailboxTokenUse = 'send' | 'imap';

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
}

export async function mintMailboxAccessToken(
  mailbox: OAuthMailbox,
  use: MailboxTokenUse,
): Promise<string> {
  const key = encryptionKey();
  const refreshToken = decrypt(mailbox.oauthRefreshTokenEncrypted, key);

  if (mailbox.provider === 'MICROSOFT_365') {
    const resource = use === 'send' ? 'graph' : 'imap';
    if (mailbox.oauthVia !== 'CONNECT') {
      return mintMicrosoftAccessToken(refreshToken, mailbox.email, resource);
    }
    const clientId = mailbox.oauthClientId;
    if (!clientId) throw new Error('Connect mailbox has no oauthClientId; reconnect it');
    return cachedAccessToken(
      accessTokenCacheKey(mailbox.id, resource, mailbox.oauthConnectedAt),
      async () => {
        const refreshed = await refreshMicrosoftConnectToken({
          refreshToken,
          email: mailbox.email,
          resource,
          clientId,
        });
        // Microsoft rotates refresh tokens. Keep the newest so the grant never ages out.
        if (refreshed.refreshToken && refreshed.refreshToken !== refreshToken) {
          await prisma.mailbox.update({
            where: { id: mailbox.id },
            data: { oauthRefreshTokenEncrypted: encrypt(refreshed.refreshToken, key) },
          });
        }
        return refreshed;
      },
    );
  }

  if (mailbox.oauthVia !== 'CONNECT') return mintGoogleAccessToken(refreshToken);
  // One Google token (scope https://mail.google.com/) covers both SMTP and IMAP.
  return cachedAccessToken(
    accessTokenCacheKey(mailbox.id, 'google', mailbox.oauthConnectedAt),
    () => refreshGoogleViaRelay(refreshToken),
  );
}
