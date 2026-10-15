import { beforeEach, describe, expect, it } from 'vitest';
import { currentAddressCheckConfig, resetAddressCheckNameCache } from '../addressCheckName';

const passed = async () => ({ serverName: 'mail.acme.example', serverNameStatus: 'PASS' });

describe('currentAddressCheckConfig', () => {
  beforeEach(() => {
    resetAddressCheckNameCache();
  });

  it('uses ADDRESS_CHECK_HELO when set, whatever the server name check says', async () => {
    const config = await currentAddressCheckConfig(
      { ADDRESS_CHECK_HELO: 'check.acme.example', MAIL_SERVER_NAME: 'mail.acme.example' },
      async () => ({ serverName: 'mail.acme.example', serverNameStatus: 'FAIL' }),
    );
    expect(config).toEqual({ helo: 'check.acme.example', mailFrom: 'check@check.acme.example' });
  });

  it('is off with neither name set, without reading the database', async () => {
    const config = await currentAddressCheckConfig({}, async () => {
      throw new Error('should not be read');
    });
    expect(config).toBeNull();
  });

  it('falls back to MAIL_SERVER_NAME once its check passed', async () => {
    const config = await currentAddressCheckConfig(
      { MAIL_SERVER_NAME: 'Mail.Acme.Example' },
      passed,
    );
    expect(config).toEqual({ helo: 'mail.acme.example', mailFrom: 'check@mail.acme.example' });
  });

  it('keeps ADDRESS_CHECK_MAIL_FROM with the server name', async () => {
    const config = await currentAddressCheckConfig(
      { MAIL_SERVER_NAME: 'mail.acme.example', ADDRESS_CHECK_MAIL_FROM: 'probe@acme.example' },
      passed,
    );
    expect(config?.mailFrom).toBe('probe@acme.example');
  });

  it('stays off while the server name is failing, unchecked, or checked under another name', async () => {
    for (const row of [
      { serverName: 'mail.acme.example', serverNameStatus: 'FAIL' },
      { serverName: 'mail.acme.example', serverNameStatus: 'PENDING' },
      { serverName: 'old.acme.example', serverNameStatus: 'PASS' },
      null,
    ]) {
      resetAddressCheckNameCache();
      const config = await currentAddressCheckConfig(
        { MAIL_SERVER_NAME: 'mail.acme.example' },
        async () => row,
      );
      expect(config).toBeNull();
    }
  });
});
