import { describe, it, expect } from 'vitest';
import { detectLeadTimezone, parseTimezoneValue } from '../leadTimezone';

describe('detectLeadTimezone', () => {
  it.each([
    [{ 'Time zone': 'Europe/Berlin' }, 'Europe/Berlin'],
    [{ timezone: 'PST' }, 'America/Los_Angeles'],
    [{ TZ: 'Eastern Time' }, 'America/New_York'],
    [{ Country: 'United States', State: 'TX' }, 'America/Chicago'],
    [{ country: 'USA', state: 'Arizona' }, 'America/Phoenix'],
    [{ Country: 'Canada', Province: 'British Columbia' }, 'America/Vancouver'],
    [{ Country: 'AU', Region: 'WA' }, 'Australia/Perth'],
    [{ Country: 'India' }, 'Asia/Kolkata'],
    [{ 'Country Code': 'de' }, 'Europe/Berlin'],
    [{ country: 'México' }, 'America/Mexico_City'],
    [{ State: 'California' }, 'America/Los_Angeles'],
    [{ City: 'London' }, 'Europe/London'],
    [{ Country: 'United States', City: 'Seattle' }, 'America/Los_Angeles'],
  ])('%o → %s', (fields, zone) => {
    expect(detectLeadTimezone(fields)).toBe(zone);
  });

  it('prefers an explicit time zone over the country', () => {
    expect(detectLeadTimezone({ timezone: 'Asia/Tokyo', country: 'France' })).toBe('Asia/Tokyo');
  });

  it('falls through a time zone it can not read to the country', () => {
    expect(detectLeadTimezone({ timezone: 'sometime', country: 'France' })).toBe('Europe/Paris');
  });

  it('returns null when a multi-zone country has no state or known city', () => {
    expect(detectLeadTimezone({ country: 'United States' })).toBeNull();
    expect(detectLeadTimezone({ country: 'Canada', city: 'Smallville' })).toBeNull();
  });

  it('returns null for nothing usable', () => {
    expect(detectLeadTimezone(null)).toBeNull();
    expect(detectLeadTimezone([])).toBeNull();
    expect(detectLeadTimezone({ title: 'CEO' })).toBeNull();
    expect(detectLeadTimezone({ country: 'Atlantis' })).toBeNull();
  });
});

describe('parseTimezoneValue', () => {
  it('reads IANA names and abbreviations, not junk', () => {
    expect(parseTimezoneValue('America/Denver')).toBe('America/Denver');
    expect(parseTimezoneValue('utc')).toBe('UTC');
    expect(parseTimezoneValue('CET')).toBe('Europe/Paris');
    expect(parseTimezoneValue('Fake/Zone')).toBeNull();
    expect(parseTimezoneValue('morning')).toBeNull();
  });
});
