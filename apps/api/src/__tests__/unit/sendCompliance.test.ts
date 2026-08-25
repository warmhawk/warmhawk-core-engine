import { describe, it, expect } from 'vitest';
import {
  assertCanSpamCompliant,
  CanSpamComplianceError,
  buildRfc8058Headers,
  isEuRecipient,
  appendEuAiDisclosureIfNeeded,
} from '../../lib/sendCompliance';

describe('CAN-SPAM auto-injection gate', () => {
  it('passes when both physical address and unsubscribe link are configured', () => {
    expect(() =>
      assertCanSpamCompliant({
        physicalMailingAddress: '123 Main St, Springfield, USA',
        unsubscribeUrlTemplate: 'https://app.example.com/unsubscribe/{token}',
      }),
    ).not.toThrow();
  });

  it('refuses to send when the physical mailing address is missing', () => {
    expect(() =>
      assertCanSpamCompliant({
        physicalMailingAddress: null,
        unsubscribeUrlTemplate: 'https://app.example.com/unsubscribe/{token}',
      }),
    ).toThrow(CanSpamComplianceError);
  });

  it('refuses to send when the unsubscribe link is missing', () => {
    expect(() =>
      assertCanSpamCompliant({
        physicalMailingAddress: '123 Main St',
        unsubscribeUrlTemplate: '',
      }),
    ).toThrow(CanSpamComplianceError);
  });
});

describe('RFC 8058 List-Unsubscribe header generation', () => {
  it('builds both required headers for an https unsubscribe URL', () => {
    const headers = buildRfc8058Headers('https://app.example.com/unsubscribe/abc123');
    expect(headers['List-Unsubscribe']).toBe('<https://app.example.com/unsubscribe/abc123>');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('accepts a mailto: fallback per RFC 8058 section 4.1', () => {
    const headers = buildRfc8058Headers('mailto:unsubscribe@example.com');
    expect(headers['List-Unsubscribe']).toBe('<mailto:unsubscribe@example.com>');
  });

  it('rejects an invalid (non-https, non-mailto) unsubscribe URL', () => {
    expect(() => buildRfc8058Headers('ftp://not-valid.com')).toThrow();
  });
});

describe('EU AI disclosure marker', () => {
  it('detects an EU recipient via ccTLD', () => {
    expect(isEuRecipient({ email: 'user@company.de' })).toBe(true);
    expect(isEuRecipient({ email: 'user@company.com' })).toBe(false);
  });

  it('prefers an explicit countryCode signal over the TLD heuristic', () => {
    expect(isEuRecipient({ email: 'user@company.com', countryCode: 'FR' })).toBe(true);
    expect(isEuRecipient({ email: 'user@company.de', countryCode: 'US' })).toBe(false);
  });

  it('appends the disclosure marker only when AI is configured AND the recipient is EU', () => {
    const result = appendEuAiDisclosureIfNeeded('Hello!', true, { email: 'user@company.de' });
    expect(result.disclosureAppended).toBe(true);
    expect(result.body).toContain('EU AI Act Article 50');
  });

  it('does not append when AI is not configured, even for an EU recipient', () => {
    const result = appendEuAiDisclosureIfNeeded('Hello!', false, { email: 'user@company.de' });
    expect(result.disclosureAppended).toBe(false);
    expect(result.body).toBe('Hello!');
  });

  it('does not append when the recipient is not EU, even with AI configured', () => {
    const result = appendEuAiDisclosureIfNeeded('Hello!', true, { email: 'user@company.com' });
    expect(result.disclosureAppended).toBe(false);
  });

  it('is idempotent — does not double-append if already present', () => {
    const once = appendEuAiDisclosureIfNeeded('Hello!', true, { email: 'user@company.de' });
    const twice = appendEuAiDisclosureIfNeeded(once.body, true, { email: 'user@company.de' });
    expect(twice.disclosureAppended).toBe(false);
    expect(twice.body).toBe(once.body);
  });
});
