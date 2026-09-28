/**
 * Warmup bounce detection — the pure DSN parsing and reason text in `lib/warmup/placement.ts`
 * (`parseBounceReport`, `bounceReasonText`). The fixtures follow the real Exchange Online and
 * Gmail report layouts, with made-up addresses and ids.
 */
import { describe, it, expect } from 'vitest';
import { bounceReasonText, parseBounceReport } from '../../lib/warmup/placement';

const exchangeNdr = [
  'From: postmaster@contoso.onmicrosoft.com',
  'To: sender@contoso.example',
  'Subject: Undeliverable: Quick question about Thursday',
  'Content-Type: multipart/report; report-type=delivery-status;',
  '\tboundary="ndr_boundary"',
  'In-Reply-To: <warm-1@contoso.example>',
  'References: <warm-1@contoso.example>',
  'X-MS-Exchange-Message-Is-Ndr: ',
  'MIME-Version: 1.0',
  '',
  '--ndr_boundary',
  'Content-Type: text/html; charset="us-ascii"',
  '',
  "<p>Your message couldn't be delivered.</p>",
  '',
  '--ndr_boundary',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns;BN0PR00MB0000.namprd00.prod.outlook.com',
  '',
  'Final-recipient: rfc822;partner@fabrikam.example',
  'Action: failed',
  'Status: 5.7.708',
  'Diagnostic-Code: smtp;550 5.7.708 Service unavailable. Access denied, traffic not accepted',
  ' from this IP. For more information please go to http://go.microsoft.com/fwlink/?LinkId=526653',
  '',
  '--ndr_boundary',
  'Content-Type: message/rfc822',
  '',
  'Message-ID: <warm-1@contoso.example>',
  'Subject: Quick question about Thursday',
  '',
  'Hi, are we still on for Thursday?',
  '--ndr_boundary--',
  '',
].join('\r\n');

const gmailDsn = [
  'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  'To: sender@example.org',
  'Subject: Delivery Status Notification (Failure)',
  'Content-Type: multipart/report; boundary="gm"; report-type=delivery-status',
  'In-Reply-To: <warm-2@example.org>',
  '',
  '--gm',
  'Content-Type: message/delivery-status',
  '',
  'Final-Recipient: rfc822; nobody@example.net',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.',
  '--gm--',
  '',
].join('\n');

describe('parseBounceReport', () => {
  it('reads the status and server reply from an Exchange Online NDR, unfolding long lines', () => {
    expect(parseBounceReport(exchangeNdr)).toEqual({
      status: '5.7.708',
      diagnostic:
        '550 5.7.708 Service unavailable. Access denied, traffic not accepted from this IP. ' +
        'For more information please go to http://go.microsoft.com/fwlink/?LinkId=526653',
    });
  });

  it('reads a Gmail DSN', () => {
    expect(parseBounceReport(gmailDsn)).toEqual({
      status: '5.1.1',
      diagnostic: '550 5.1.1 The email account that you tried to reach does not exist.',
    });
  });

  it('ignores a report that only says delivery is delayed', () => {
    const delayed = gmailDsn
      .replace('Action: failed', 'Action: delayed')
      .replace('Status: 5.1.1', 'Status: 4.4.7');
    expect(parseBounceReport(delayed)).toBeNull();
  });

  it('ignores an ordinary reply in the same thread', () => {
    const reply = [
      'From: partner@fabrikam.example',
      'Content-Type: text/plain; charset=utf-8',
      'In-Reply-To: <warm-1@contoso.example>',
      '',
      'Action: failed is just words in a reply',
    ].join('\r\n');
    expect(parseBounceReport(reply)).toBeNull();
  });
});

describe('bounceReasonText', () => {
  it('explains the Microsoft 365 outbound block and who can lift it', () => {
    for (const status of ['5.7.708', '5.7.705']) {
      const text = bounceReasonText({ status, diagnostic: '550 whatever' });
      expect(text).toContain(
        `Microsoft 365 blocked this email before it left your organization (${status})`,
      );
      expect(text).toContain('Microsoft support');
    }
  });

  it('quotes the server for anything else', () => {
    expect(bounceReasonText({ status: '5.1.1', diagnostic: '550 5.1.1 No such user' })).toBe(
      'The mail server returned this email (5.1.1): 550 5.1.1 No such user',
    );
    expect(bounceReasonText({ status: null, diagnostic: null })).toBe(
      'The mail server returned this email.',
    );
  });

  it('caps a long server reply', () => {
    expect(bounceReasonText({ status: '5.0.0', diagnostic: 'x'.repeat(2000) })).toHaveLength(500);
  });
});
