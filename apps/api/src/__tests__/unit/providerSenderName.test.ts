import { describe, expect, it, vi } from 'vitest';
import { cleanProviderName, fetchGmailSendAsName } from '../../lib/providerSenderName';

describe('cleanProviderName', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanProviderName('  Sam   Patel ', 'sam@acme.example')).toBe('Sam Patel');
  });

  it('turns CR/LF into spaces so the name is safe in a From header', () => {
    expect(cleanProviderName('Sam\r\nPatel', 'sam@acme.example')).toBe('Sam Patel');
  });

  it('refuses blanks, non-strings, and addresses', () => {
    for (const value of ['', '   ', null, undefined, 42, 'sam@acme.example', 'SAM@ACME.EXAMPLE']) {
      expect(cleanProviderName(value, 'sam@acme.example')).toBeNull();
    }
  });

  it('caps the name at 80 characters, the same limit a typed name has', () => {
    expect(cleanProviderName('a'.repeat(200), 'sam@acme.example')).toHaveLength(80);
  });
});

describe('fetchGmailSendAsName', () => {
  it('reads the display name of the address from Gmail send-as settings', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ displayName: 'Sam Patel' }));
    await expect(fetchGmailSendAsName('token', 'sam@acme.example', fetchImpl)).resolves.toBe(
      'Sam Patel',
    );
  });

  it('returns null instead of throwing when Gmail refuses or the network fails', async () => {
    const refused = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const offline = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(fetchGmailSendAsName('token', 'sam@acme.example', refused)).resolves.toBeNull();
    await expect(fetchGmailSendAsName('token', 'sam@acme.example', offline)).resolves.toBeNull();
  });
});
