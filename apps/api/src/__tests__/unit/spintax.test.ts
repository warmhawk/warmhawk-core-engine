import { describe, it, expect } from 'vitest';
import { renderSpintax, hasSpintax, listSpintaxGroups, SpintaxParseError } from '../../lib/spintax';

describe('spintax parser/renderer', () => {
  it('renders plain text with no spintax unchanged', () => {
    expect(renderSpintax('Hi there, how are you?')).toBe('Hi there, how are you?');
  });

  it('resolves a single spintax group to one of its options', () => {
    const options = ['Hi', 'Hello', 'Hey'];
    for (let i = 0; i < 20; i++) {
      const rendered = renderSpintax('{Hi|Hello|Hey} there');
      const chosen = rendered.replace(' there', '');
      expect(options).toContain(chosen);
    }
  });

  it('deterministically picks the option matching a fixed rng', () => {
    expect(renderSpintax('{a|b|c}', () => 0)).toBe('a');
    expect(renderSpintax('{a|b|c}', () => 0.5)).toBe('b');
    expect(renderSpintax('{a|b|c}', () => 0.99)).toBe('c');
  });

  it('resolves multiple independent groups in the same template', () => {
    const rendered = renderSpintax(
      '{Hi|Hello} {John|Jane}, {great to connect|nice to meet you}',
      () => 0,
    );
    expect(rendered).toBe('Hi John, great to connect');
  });

  it('resolves nested spintax groups (innermost first)', () => {
    // Outer group's first option itself contains a nested group.
    const rendered = renderSpintax('{Hi {John|Jane}|Hello there}', () => 0);
    expect(rendered).toBe('Hi John');
  });

  it('round-trips: rendering a template with no variation points is idempotent', () => {
    const plain = 'Just a normal sentence with {no pipe here}'; // single option, no '|'
    // A `{single-option}` group with no pipe still resolves to its one option.
    expect(renderSpintax(plain)).toBe('Just a normal sentence with no pipe here');
  });

  it('throws SpintaxParseError on unbalanced braces (missing close)', () => {
    expect(() => renderSpintax('{unclosed|group')).toThrow(SpintaxParseError);
  });

  it('throws SpintaxParseError on unbalanced braces (stray close)', () => {
    expect(() => renderSpintax('stray}brace')).toThrow(SpintaxParseError);
  });

  it('hasSpintax detects presence/absence of a real variation group', () => {
    expect(hasSpintax('{a|b}')).toBe(true);
    expect(hasSpintax('no variation here')).toBe(false);
    expect(hasSpintax('{single-option-no-pipe}')).toBe(false);
  });

  it('listSpintaxGroups extracts every option set without rendering', () => {
    const groups = listSpintaxGroups('{Hi|Hello} there, {John|Jane}');
    expect(groups).toEqual([
      ['Hi', 'Hello'],
      ['John', 'Jane'],
    ]);
  });
});
