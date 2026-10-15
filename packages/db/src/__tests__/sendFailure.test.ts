import { describe, expect, it } from 'vitest';
import { isDeferral, isSendingLimit } from '../sendFailure';

describe('isSendingLimit', () => {
  it('knows a provider limit, even one sent as a 550', () => {
    expect(
      isSendingLimit(
        'Message failed: 550 5.4.5 Daily user sending limit exceeded. For more information',
      ),
    ).toBe(true);
    expect(
      isSendingLimit(
        '554 5.2.0 STOREDRV.Submission.Exception:SubmissionQuotaExceededException; Failed to process message',
      ),
    ).toBe(true);
    expect(
      isSendingLimit('550 5.1.1 The email account that you tried to reach does not exist'),
    ).toBe(false);
  });
});

describe('isDeferral', () => {
  it('reads 4xx replies and "try again later" as deferrals', () => {
    expect(isDeferral('Message failed: 421 4.7.0 Try again later, closing connection.')).toBe(true);
    expect(isDeferral('451 4.7.650 The mail server has been temporarily rate limited')).toBe(true);
    expect(
      isDeferral(
        'Message failed: 450 4.2.1 The user you are trying to contact is receiving mail too quickly',
      ),
    ).toBe(true);
  });

  it('ignores bounces, ports and the address check’s own rows', () => {
    expect(isDeferral('550 5.1.1 user unknown')).toBe(false);
    expect(isDeferral('connect ETIMEDOUT 142.250.27.108:465')).toBe(false);
    expect(
      isDeferral('Not sent: the mail server gave no clear answer (450 4.2.0 greylisted)'),
    ).toBe(false);
    expect(isDeferral(null)).toBe(false);
  });
});
