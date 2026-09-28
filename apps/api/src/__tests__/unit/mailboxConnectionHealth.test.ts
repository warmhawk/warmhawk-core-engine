/**
 * "Needs reconnect" (lib/mailboxConnectionHealth.ts): only failures a reconnect fixes are stored on
 * the mailbox; timeouts and one-off refusals are left alone. Prisma is mocked — never a live DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `update` only records calls; what the "DB" returns comes from `updateResult`, so a failing DB can
// be simulated without a spy handing back a rejected promise (vitest tracks those as unhandled).
const update = vi.fn();
let updateResult: () => Promise<unknown> = async () => ({});
vi.mock('@warmhawk/db', () => ({
  prisma: {
    mailbox: {
      update: (...args: unknown[]) => {
        update(...args);
        return updateResult();
      },
    },
  },
}));

import {
  clearConnectionFailure,
  connectionErrorFor,
  recordConnectionFailure,
} from '../../lib/mailboxConnectionHealth';
import { ConnectRelayError } from '../../lib/connectRelay';
import { MicrosoftTokenError } from '../../lib/microsoftOAuth';
import { GraphSendError } from '../../lib/microsoftGraphTransport';

describe('connectionErrorFor', () => {
  it.each([
    [
      'Microsoft approval removed',
      new MicrosoftTokenError('invalid_grant', 'AADSTS65001: not consented'),
      /approval/,
    ],
    ['Microsoft consent_required', new MicrosoftTokenError('consent_required', ''), /approval/],
    [
      'Microsoft revoked grant',
      new MicrosoftTokenError('invalid_grant', 'AADSTS70000: revoked'),
      /Microsoft no longer accepts/,
    ],
    [
      'Graph: no mailbox',
      new GraphSendError('no mailbox', 404, 'MailboxNotEnabledForRESTAPI'),
      /Exchange Online license/,
    ],
    [
      'Graph: bad token',
      new GraphSendError('unauthorized', 401, 'InvalidAuthenticationToken'),
      /Microsoft no longer accepts/,
    ],
    [
      'Google via relay',
      new ConnectRelayError('invalid_grant', 'revoked'),
      /Google no longer accepts/,
    ],
    [
      'Google BYO (gaxios)',
      Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } }),
      /Google no longer accepts/,
    ],
    [
      'SMTP 535',
      Object.assign(new Error('auth'), { code: 'EAUTH', responseCode: 535 }),
      /mail server rejected/,
    ],
    [
      'IMAP auth',
      Object.assign(new Error('auth'), { authenticationFailed: true }),
      /mail server rejected/,
    ],
  ])('flags %s', (_label, err, reason) => {
    expect(connectionErrorFor(err)).toMatch(reason);
  });

  it.each([
    ['a timeout', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })],
    ['a relay outage', new ConnectRelayError('relay_unreachable', 'down')],
    ['a Microsoft server error', new MicrosoftTokenError('http_503', '')],
    ['a Graph throttle', new GraphSendError('slow down', 429, 'ApplicationThrottled')],
    ['a recipient refusal', Object.assign(new Error('mailbox full'), { responseCode: 552 })],
    ['a non-error', undefined],
  ])('leaves %s alone', (_label, err) => {
    expect(connectionErrorFor(err)).toBeNull();
  });
});

describe('recordConnectionFailure / clearConnectionFailure', () => {
  beforeEach(() => {
    update.mockReset();
    updateResult = async () => ({});
  });

  it('stores the reason and when it happened', async () => {
    await recordConnectionFailure('mb-1', new ConnectRelayError('invalid_grant', 'revoked'));
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mb-1' },
      data: {
        connectionError: expect.stringMatching(/Google/),
        connectionErrorAt: expect.any(Date),
      },
    });
  });

  it('writes nothing for a failure a reconnect would not fix', async () => {
    await recordConnectionFailure('mb-1', new Error('socket hang up'));
    expect(update).not.toHaveBeenCalled();
  });

  it('never throws, so the caller still sees its own error', async () => {
    updateResult = async () => {
      throw new Error('db down');
    };
    await expect(
      recordConnectionFailure('mb-1', new ConnectRelayError('invalid_grant', 'revoked')),
    ).resolves.toBeUndefined();
    await expect(clearConnectionFailure('mb-1')).resolves.toBeUndefined();
  });

  it('clears the reason', async () => {
    await clearConnectionFailure('mb-1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mb-1' },
      data: { connectionError: null, connectionErrorAt: null },
    });
  });
});
