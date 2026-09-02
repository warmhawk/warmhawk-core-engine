import { describe, it, expect } from 'vitest';
import { parseLeadsCsv } from '../../routes/leads';

describe('parseLeadsCsv — CSV column recognition + customFields folding', () => {
  it('recognizes email/firstName/lastName/company case-insensitively', () => {
    const csv = 'Email,FirstName,LastName,Company\njane@example.com,Jane,Doe,Acme Corp\n';
    const rows = parseLeadsCsv(Buffer.from(csv), 'camp_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      campaignId: 'camp_1',
      email: 'jane@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      company: 'Acme Corp',
    });
  });

  it('folds unrecognized columns into customFields', () => {
    const csv = 'email,title,industry\njohn@example.com,VP Sales,SaaS\n';
    const rows = parseLeadsCsv(Buffer.from(csv), 'camp_1');
    expect(rows[0].customFields).toEqual({ title: 'VP Sales', industry: 'SaaS' });
  });

  it('parses multiple rows in order', () => {
    const csv = 'email\na@example.com\nb@example.com\nc@example.com\n';
    const rows = parseLeadsCsv(Buffer.from(csv), 'camp_1');
    expect(rows.map((r) => r.email)).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
  });

  it('handles an empty customFields set when only known columns are present', () => {
    const csv = 'email,firstName\na@example.com,A\n';
    const rows = parseLeadsCsv(Buffer.from(csv), 'camp_1');
    expect(rows[0].customFields).toEqual({});
  });

  it('trims whitespace in header and values', () => {
    const csv = ' email , firstName \n a@example.com , A \n';
    const rows = parseLeadsCsv(Buffer.from(csv), 'camp_1');
    expect(rows[0].email).toBe('a@example.com');
    expect(rows[0].firstName).toBe('A');
  });
});
