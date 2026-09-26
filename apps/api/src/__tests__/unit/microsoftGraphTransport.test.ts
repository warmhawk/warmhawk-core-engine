import { describe, it, expect, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { createGraphTransport } from '../../lib/microsoftGraphTransport';

function graphFetch(ok = true, status = 202, body: unknown = null) {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => body }) as unknown as typeof fetch;
}

function sentMime(fetchImpl: typeof fetch): string {
  const init = vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit;
  return Buffer.from(init.body as string, 'base64').toString('utf8');
}

describe('Microsoft Graph send transport (HTTP boundary mocked, never live)', () => {
  it('posts the composed MIME to /me/sendMail with the bearer token, keeping Bcc and List-Unsubscribe', async () => {
    const fetchImpl = graphFetch();
    const transporter = nodemailer.createTransport(createGraphTransport('graph-at', fetchImpl));

    const info = await transporter.sendMail({
      from: 'sales@contoso.com',
      to: 'lead@example.com',
      bcc: ['seed@example.net'],
      subject: 'Hello',
      text: 'Body',
      headers: { 'List-Unsubscribe': '<https://u.example.com/x>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer graph-at');
    expect((init.headers as Record<string, string>)['content-type']).toBe('text/plain');

    const mime = sentMime(fetchImpl);
    expect(mime).toMatch(/^Bcc: seed@example\.net/m);
    expect(mime).toMatch(/^List-Unsubscribe: <https:\/\/u\.example\.com\/x>/m);
    expect(mime).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
    expect(mime).toContain(`Message-ID: ${info.messageId}`);
  });

  it('rejects with the Graph error code and HTTP status so the sender can classify it', async () => {
    const fetchImpl = graphFetch(false, 403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } });
    const transporter = nodemailer.createTransport(createGraphTransport('graph-at', fetchImpl));

    await expect(
      transporter.sendMail({ from: 'a@contoso.com', to: 'b@example.com', subject: 's', text: 't' }),
    ).rejects.toMatchObject({ responseCode: 403, code: 'ErrorAccessDenied', message: 'ErrorAccessDenied: Access is denied.' });
  });
});
