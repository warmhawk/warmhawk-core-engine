import { describe, it, expect } from 'vitest';
import { validateLeadFields, BLOCKED_EMAIL_DOMAINS } from '../../lib/leadIngest';

describe('validateLeadFields — shared lead-ingest validation (pure, format-only checks)', () => {
  it('accepts a well-formed lead', () => {
    const result = validateLeadFields({
      campaignId: 'camp_123',
      email: 'Jane.Doe@Example.org',
      firstName: ' Jane ',
      lastName: 'Doe',
      company: 'Acme Corp',
      customFields: { title: 'VP Sales' },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.lead.email).toBe('jane.doe@example.org'); // trimmed + lowercased
      expect(result.lead.firstName).toBe('Jane'); // trimmed
    }
  });

  it('rejects a missing campaignId', () => {
    const result = validateLeadFields({ campaignId: '', email: 'a@b.com' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('missing_campaign_id');
  });

  it.each(['not-an-email', 'missing-at-sign.com', '@no-local-part.com', 'no-domain@'])(
    'rejects invalid email format: %s',
    (email) => {
      const result = validateLeadFields({ campaignId: 'camp_123', email });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe('invalid_email');
    },
  );

  it.each(BLOCKED_EMAIL_DOMAINS)('rejects blocked domain: %s', (domain) => {
    const result = validateLeadFields({ campaignId: 'camp_123', email: `test@${domain}` });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('blocked_domain');
  });

  it('rejects a lead whose company field is a CSV-injection risk', () => {
    const result = validateLeadFields({
      campaignId: 'camp_123',
      email: 'a@b.com',
      company: '=cmd|"/c calc"!A1',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('csv_injection_risk');
  });

  it('rejects a lead whose customFields contain a CSV-injection risk', () => {
    const result = validateLeadFields({
      campaignId: 'camp_123',
      email: 'a@b.com',
      customFields: { notes: '@SUM(1,2)' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('csv_injection_risk');
  });

  it('defaults optional fields to null/empty object when absent', () => {
    const result = validateLeadFields({ campaignId: 'camp_123', email: 'a@b.com' });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.lead.firstName).toBeNull();
      expect(result.lead.lastName).toBeNull();
      expect(result.lead.company).toBeNull();
      expect(result.lead.customFields).toEqual({});
    }
  });
});
