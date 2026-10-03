import { describe, expect, it } from 'vitest';
import {
  checkFields,
  evaluateLaunch,
  type ReadinessCampaign,
  type ReadinessMailbox,
} from '../../lib/sendingReadiness';

function mailbox(overrides: Partial<ReadinessMailbox> = {}): ReadinessMailbox {
  return {
    id: 'mb-1',
    email: 'sam@brand.com',
    status: 'ACTIVE',
    senderName: 'Sam',
    domain: { id: 'd-1', domainName: 'brand.com', mailingAddress: '1 Main St\nSpringfield' },
    ...overrides,
  };
}

function campaign(overrides: Partial<ReadinessCampaign> = {}): ReadinessCampaign {
  return {
    status: 'DRAFT',
    template: 'Hi {{firstName}}',
    subject: 'Idea',
    unsubscribeUrlTemplate: null,
    pausedForBounceRate: false,
    mailboxes: [mailbox()],
    steps: [],
    ...overrides,
  };
}

describe('evaluateLaunch', () => {
  it('passes a ready campaign', () => {
    const check = evaluateLaunch(campaign(), { builtInUnsubscribe: true, leadCount: 10 });
    expect(check.canLaunch).toBe(true);
    expect(check.problems).toEqual([]);
    expect(check.passed).toEqual(['SENDERS', 'ADDRESSES', 'UNSUBSCRIBE', 'BOUNCE', 'COPY']);
  });

  it('returns every problem at once', () => {
    const check = evaluateLaunch(
      campaign({
        template: ' ',
        pausedForBounceRate: true,
        mailboxes: [
          mailbox({ domain: { id: 'd-1', domainName: 'a.com', mailingAddress: null } }),
          mailbox({ id: 'mb-2', domain: { id: 'd-1', domainName: 'a.com', mailingAddress: null } }),
          mailbox({ id: 'mb-3', domain: { id: 'd-2', domainName: 'b.com', mailingAddress: '  ' } }),
        ],
        steps: [{ position: 1, body: '' }],
      }),
      { builtInUnsubscribe: false },
    );
    expect(check.canLaunch).toBe(false);
    expect(check.problems.map((p) => p.code)).toEqual([
      'DOMAIN_NO_ADDRESS',
      'DOMAIN_NO_ADDRESS',
      'NO_UNSUBSCRIBE',
      'BOUNCE_PAUSED',
      'EMAIL_EMPTY',
      'STEP_EMPTY',
    ]);
    expect(check.problems[0]).toMatchObject({ domainName: 'a.com', mailboxCount: 2 });
  });

  it('needs at least one mailbox that is not paused', () => {
    expect(
      evaluateLaunch(campaign({ mailboxes: [] }), { builtInUnsubscribe: true }).problems[0]?.code,
    ).toBe('NO_SENDERS');
    const paused = evaluateLaunch(campaign({ mailboxes: [mailbox({ status: 'PAUSED' })] }), {
      builtInUnsubscribe: true,
    });
    expect(paused.problems.map((p) => p.code)).toEqual(['NO_SENDERS']);
  });

  it('ignores a paused mailbox whose domain has no address', () => {
    const check = evaluateLaunch(
      campaign({
        mailboxes: [
          mailbox(),
          mailbox({
            id: 'mb-2',
            status: 'PAUSED',
            domain: { id: 'd-9', domainName: 'x.com', mailingAddress: null },
          }),
        ],
      }),
      { builtInUnsubscribe: true },
    );
    expect(check.canLaunch).toBe(true);
  });

  it('warns without blocking: no sender name, all warming, no leads, blank fields', () => {
    const check = evaluateLaunch(
      campaign({
        template: 'Hi {{firstName}} at {{city}}',
        mailboxes: [mailbox({ senderName: null, status: 'WARMUP' })],
      }),
      {
        builtInUnsubscribe: true,
        leadCount: 0,
        fieldLeads: [{ firstName: null, lastName: null, company: null, customFields: {} }],
      },
    );
    expect(check.canLaunch).toBe(true);
    expect(check.warnings.map((w) => w.code)).toEqual([
      'ALL_WARMING',
      'SENDER_NAME_MISSING',
      'NO_LEADS',
      'FIELD_BLANK',
      'FIELD_UNKNOWN',
    ]);
  });

  it('accepts a campaign unsubscribe link when there is no built-in page', () => {
    const check = evaluateLaunch(
      campaign({ unsubscribeUrlTemplate: 'https://x.com/u?e={{email}}' }),
      {
        builtInUnsubscribe: false,
      },
    );
    expect(check.canLaunch).toBe(true);
  });
});

describe('checkFields', () => {
  it('counts blanks for known fields and flags unknown ones', () => {
    const result = checkFields(
      ['{{firstName}} {{City}} {{nope}} {{senderName}}'],
      [
        { firstName: 'A', lastName: null, company: null, customFields: { city: 'Austin' } },
        { firstName: '', lastName: null, company: null, customFields: { city: '' } },
      ],
    );
    expect(result.fields).toEqual([
      { name: 'firstName', status: 'partial', missingCount: 1 },
      { name: 'City', status: 'partial', missingCount: 1 },
      { name: 'nope', status: 'unknown', missingCount: 2 },
      { name: 'senderName', status: 'ok', missingCount: 0 },
    ]);
    expect(result.available).toContain('city');
  });
});
