import { describe, it, expect } from 'vitest';
import { MAX_PAGE_SIZE, parseChoice, parsePage, wantsPage } from '../../lib/pagination';

describe('parsePage', () => {
  it('defaults to page 1 of 25, or the route default', () => {
    expect(parsePage({})).toEqual({ ok: true, value: { page: 1, pageSize: 25, skip: 0, take: 25 } });
    expect(parsePage({}, 50)).toMatchObject({ ok: true, value: { pageSize: 50 } });
  });

  it('turns page and pageSize into skip/take', () => {
    expect(parsePage({ page: '3', pageSize: '10' })).toEqual({
      ok: true,
      value: { page: 3, pageSize: 10, skip: 20, take: 10 },
    });
  });

  it('caps pageSize', () => {
    expect(parsePage({ pageSize: '100000' })).toMatchObject({ ok: true, value: { pageSize: MAX_PAGE_SIZE } });
  });

  it.each(['0', '-1', '1.5', 'abc', ' 2'])('rejects page %j', (page) => {
    expect(parsePage({ page }).ok).toBe(false);
    expect(parsePage({ pageSize: page }).ok).toBe(false);
  });

  it('treats an empty value as not given', () => {
    expect(parsePage({ page: '', pageSize: '' })).toMatchObject({ ok: true, value: { page: 1, pageSize: 25 } });
  });
});

describe('wantsPage', () => {
  it('is true when either paging param is present', () => {
    expect(wantsPage({})).toBe(false);
    expect(wantsPage({ page: '1' })).toBe(true);
    expect(wantsPage({ pageSize: '10' })).toBe(true);
  });
});

describe('parseChoice', () => {
  const allowed = ['inbox', 'spam'] as const;
  it('accepts an allowed value and treats empty as no filter', () => {
    expect(parseChoice('spam', allowed, 'result')).toEqual({ ok: true, value: 'spam' });
    expect(parseChoice(undefined, allowed, 'result')).toEqual({ ok: true, value: undefined });
    expect(parseChoice('', allowed, 'result')).toEqual({ ok: true, value: undefined });
  });

  it('names the allowed values in the error', () => {
    expect(parseChoice('junk', allowed, 'result')).toEqual({ ok: false, error: 'result must be one of: inbox, spam' });
  });
});
