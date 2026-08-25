import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, loadEncryptionKey, maskSecret, safeCompare } from '../../lib/encryption';

describe('AES-256-GCM encryption helper', () => {
  const key = randomBytes(32);

  it('round-trips plaintext through encrypt/decrypt', () => {
    const plaintext = 'refresh-token-super-secret-value-1234567890';
    const encrypted = encrypt(plaintext, key);
    expect(encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(decrypt(encrypted, key)).toBe(plaintext);
  });

  it('round-trips an empty string', () => {
    const encrypted = encrypt('', key);
    expect(decrypt(encrypted, key)).toBe('');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encrypt('same-plaintext', key);
    const b = encrypt('same-plaintext', key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe(decrypt(b, key));
  });

  it('fails to decrypt with the wrong key', () => {
    const encrypted = encrypt('secret', key);
    const wrongKey = randomBytes(32);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('fails to decrypt tampered ciphertext (auth tag mismatch)', () => {
    const encrypted = encrypt('secret', key);
    const [iv, tag, ciphertext] = encrypted.split(':');
    const tamperedByte = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === '00' ? '01' : '00');
    expect(() => decrypt(`${iv}:${tag}:${tamperedByte}`, key)).toThrow();
  });

  it('rejects a malformed payload', () => {
    expect(() => decrypt('not-a-valid-payload', key)).toThrow(/Malformed encrypted payload/);
  });

  it('loadEncryptionKey accepts a base64-encoded 32-byte key', () => {
    const b64 = key.toString('base64');
    const loaded = loadEncryptionKey(b64);
    expect(loaded.equals(key)).toBe(true);
  });

  it('loadEncryptionKey accepts a hex-encoded 32-byte key', () => {
    const hex = key.toString('hex');
    const loaded = loadEncryptionKey(hex);
    expect(loaded.equals(key)).toBe(true);
  });

  it('loadEncryptionKey rejects an empty key', () => {
    expect(() => loadEncryptionKey('')).toThrow(/empty/);
  });

  it('loadEncryptionKey rejects a key of the wrong length', () => {
    expect(() => loadEncryptionKey(Buffer.from('too-short').toString('base64'))).toThrow(
      /32 bytes/,
    );
  });

  it('maskSecret shows only the trailing characters', () => {
    expect(maskSecret('sk-abcdefghijklmnop')).toMatch(/\*+mnop$/);
  });

  it('maskSecret fully masks very short secrets', () => {
    expect(maskSecret('abc')).toBe('***');
  });

  it('safeCompare returns true for equal strings and false otherwise', () => {
    expect(safeCompare('secret-value', 'secret-value')).toBe(true);
    expect(safeCompare('secret-value', 'different-value')).toBe(false);
    expect(safeCompare('short', 'much-longer-string')).toBe(false);
  });
});
