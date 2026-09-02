import { describe, it, expect } from 'vitest';
import {
  isCsvInjectionRisk,
  neutralizeCsvValue,
  checkCsvField,
  findCsvInjectionInRow,
} from '../../lib/csvInjection';

describe('CSV injection defense', () => {
  it.each(['=cmd|"/c calc"!A1', '+1+1', '-2+3', '@SUM(A1:A2)', '  =leadingspace'])(
    'flags %s as a CSV injection risk',
    (value) => {
      expect(isCsvInjectionRisk(value)).toBe(true);
    },
  );

  it.each(['Acme Corp', 'John Doe', 'john@example.com', '123 Main St', ''])(
    'does not flag %s as a risk',
    (value) => {
      expect(isCsvInjectionRisk(value)).toBe(false);
    },
  );

  it('neutralizes a risky value with a leading single quote, preserving content', () => {
    const neutralized = neutralizeCsvValue('=cmd|"/c calc"!A1');
    expect(neutralized).toBe('\'=cmd|"/c calc"!A1');
    expect(isCsvInjectionRisk(neutralized.slice(1))).toBe(true); // original content preserved
  });

  it('leaves safe values unchanged when neutralizing', () => {
    expect(neutralizeCsvValue('Acme Corp')).toBe('Acme Corp');
  });

  it('checkCsvField with reject policy returns unsafe + reason for risky input', () => {
    const result = checkCsvField('=1+1', 'reject');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/formula-injection/);
  });

  it('checkCsvField with neutralize policy returns safe + a quoted value', () => {
    const result = checkCsvField('=1+1', 'neutralize');
    expect(result.safe).toBe(true);
    expect(result.value).toBe("'=1+1");
  });

  it('checkCsvField passes safe values through unchanged under either policy', () => {
    expect(checkCsvField('Acme Corp', 'reject')).toEqual({ safe: true, value: 'Acme Corp' });
    expect(checkCsvField('Acme Corp', 'neutralize')).toEqual({ safe: true, value: 'Acme Corp' });
  });

  it('findCsvInjectionInRow finds the first offending field across a row', () => {
    const row = { firstName: 'John', company: '=cmd|"/c calc"!A1', lastName: 'Doe' };
    const result = findCsvInjectionInRow(row);
    expect(result).not.toBeNull();
    expect(result?.field).toBe('company');
  });

  it('findCsvInjectionInRow returns null for a fully safe row', () => {
    const row = { firstName: 'John', company: 'Acme', lastName: 'Doe' };
    expect(findCsvInjectionInRow(row)).toBeNull();
  });

  it('findCsvInjectionInRow ignores non-string fields', () => {
    const row = { firstName: 'John', age: 42, active: true };
    expect(findCsvInjectionInRow(row)).toBeNull();
  });
});
