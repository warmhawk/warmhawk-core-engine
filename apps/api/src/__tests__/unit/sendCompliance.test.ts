import { describe, it, expect } from 'vitest';
import {
  assertCanSpamCompliant,
  CanSpamComplianceError,
  buildRfc8058Headers,
  isEuRecipient,
  appendEuAiDisclosureIfNeeded,
  appendCanSpamFooter,
  resolveUnsubscribeUrl,
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

describe('CAN-SPAM footer in the body', () => {
  const address = '100 Example Street, Springfield, ST 00000';
  const unsubscribeUrl = 'https://acme.example/unsubscribe?email=dana%40acme.example';

  it('appends the address and a visible unsubscribe line after the email', () => {
    const result = appendCanSpamFooter('Hi Dana,\n\nBest, Sam', { physicalMailingAddress: address, unsubscribeUrl });
    expect(result).toEqual({
      body: `Hi Dana,\n\nBest, Sam\n\n--\n${address}\nUnsubscribe: ${unsubscribeUrl}`,
      footerAppended: true,
    });
  });

  it('closes the email after the EU AI disclosure, never before it', () => {
    const withDisclosure = appendEuAiDisclosureIfNeeded('Hi Dana,', true, { email: 'dana@acme.de' }).body;
    const { body } = appendCanSpamFooter(withDisclosure, { physicalMailingAddress: address, unsubscribeUrl });
    expect(body.indexOf('EU AI Act Article 50')).toBeLessThan(body.indexOf(address));
    expect(body.endsWith(`Unsubscribe: ${unsubscribeUrl}`)).toBe(true);
  });

  it('trims trailing whitespace off the body so the footer sits one blank line below it', () => {
    const { body } = appendCanSpamFooter('Hi Dana,\n\n\n  ', { physicalMailingAddress: address, unsubscribeUrl });
    expect(body.startsWith('Hi Dana,\n\n--\n')).toBe(true);
  });

  it('keeps a multi-line address on its own lines, trimmed, with blank lines dropped', () => {
    const { body } = appendCanSpamFooter('Hi', {
      physicalMailingAddress: '  100 Example Street \n\n Springfield, ST 00000  ',
      unsubscribeUrl,
    });
    expect(body).toBe(`Hi\n\n--\n100 Example Street\nSpringfield, ST 00000\nUnsubscribe: ${unsubscribeUrl}`);
  });

  it('works with a mailto: unsubscribe', () => {
    const { body } = appendCanSpamFooter('Hi', {
      physicalMailingAddress: address,
      unsubscribeUrl: 'mailto:unsubscribe@acme.example',
    });
    expect(body.endsWith('Unsubscribe: mailto:unsubscribe@acme.example')).toBe(true);
  });

  describe('never duplicates what the email already says', () => {
    it('skips the address when the body signs off with it, even wrapped and in another case', () => {
      const body = `Best, Sam\n100 EXAMPLE STREET,\n  Springfield, ST 00000`;
      const result = appendCanSpamFooter(body, { physicalMailingAddress: address, unsubscribeUrl });
      expect(result.body).toBe(`${body}\n\n--\nUnsubscribe: ${unsubscribeUrl}`);
      expect(result.body.toLowerCase().split('example street').length - 1).toBe(1);
    });

    it('skips the unsubscribe line when the body already links it', () => {
      const body = `Hi\nOpt out here: ${unsubscribeUrl}`;
      expect(appendCanSpamFooter(body, { physicalMailingAddress: address, unsubscribeUrl }).body).toBe(
        `${body}\n\n--\n${address}`,
      );
    });

    it('leaves the body untouched when it has both', () => {
      const body = `Hi\n${address}\n${unsubscribeUrl}`;
      expect(appendCanSpamFooter(body, { physicalMailingAddress: address, unsubscribeUrl })).toEqual({
        body,
        footerAppended: false,
      });
    });

    it('is idempotent — running it twice adds one footer', () => {
      const once = appendCanSpamFooter('Hi', { physicalMailingAddress: address, unsubscribeUrl }).body;
      expect(appendCanSpamFooter(once, { physicalMailingAddress: address, unsubscribeUrl })).toEqual({
        body: once,
        footerAppended: false,
      });
    });

    it("still adds the address when the body only mentions part of it", () => {
      const { body } = appendCanSpamFooter('We are based in Springfield.', { physicalMailingAddress: address, unsubscribeUrl });
      expect(body).toContain(`--\n${address}`);
    });
  });

  describe('refuses rather than sending a footer with a hole in it', () => {
    it.each([
      ['no address', { physicalMailingAddress: null, unsubscribeUrl }],
      ['a blank address', { physicalMailingAddress: '   ', unsubscribeUrl }],
      ['no unsubscribe link', { physicalMailingAddress: address, unsubscribeUrl: undefined }],
      ['a blank unsubscribe link', { physicalMailingAddress: address, unsubscribeUrl: ' ' }],
    ])('%s', (_label, input) => {
      expect(() => appendCanSpamFooter('Hi', input)).toThrow(CanSpamComplianceError);
    });
  });
});

describe('resolveUnsubscribeUrl', () => {
  it('fills {{email}} with the recipient, URL-encoded', () => {
    expect(resolveUnsubscribeUrl('https://acme.example/u?email={{email}}', 'dana+sales@acme.example')).toBe(
      'https://acme.example/u?email=dana%2Bsales%40acme.example',
    );
  });

  it('tolerates spaces and case inside the braces, and fills every occurrence', () => {
    expect(resolveUnsubscribeUrl('https://acme.example/u/{{ Email }}?r={{email}}', 'a@b.example')).toBe(
      'https://acme.example/u/a%40b.example?r=a%40b.example',
    );
  });

  it('uses a template with no placeholder as-is', () => {
    expect(resolveUnsubscribeUrl('https://acme.example/unsubscribe', 'a@b.example')).toBe('https://acme.example/unsubscribe');
  });
});
