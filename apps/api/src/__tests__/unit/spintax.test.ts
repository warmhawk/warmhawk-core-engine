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

  // Regression guard for the spintax/merge-field regex collision (fixed 2026-09-04). Before the
  // fix, a merge field's inner `{token}` (from `{{token}}`) looked exactly like the single-option
  // no-pipe group the test above intentionally DOES resolve, and got collapsed to bare text —
  // corrupting real send content if this function were ever called before merge fields were
  // filled, and definitely corrupting `listSpintaxGroups`'s save-time count in
  // `apps/api/src/routes/campaigns.ts#evaluateContentQuality`, which runs on the raw, unfilled
  // template.
  describe('merge-field ({{token}}) collision', () => {
    it('renderSpintax leaves a {{mergeField}} token completely untouched', () => {
      expect(renderSpintax('Hi {{firstName}}, thanks for stopping by')).toBe(
        'Hi {{firstName}}, thanks for stopping by',
      );
    });

    it('renderSpintax resolves a real spintax group next to an untouched merge field', () => {
      const rendered = renderSpintax(
        'Hi {{firstName}}, {great to connect|nice to meet you} re {{company}}',
        () => 0,
      );
      expect(rendered).toBe('Hi {{firstName}}, great to connect re {{company}}');
    });

    it('hasSpintax still reports false for a template with only merge fields', () => {
      expect(hasSpintax('Hi {{firstName}}, thanks for stopping by {{company}}')).toBe(false);
    });

    it('listSpintaxGroups reports zero groups for a template with only merge fields', () => {
      expect(listSpintaxGroups('Hi {{firstName}}, thanks for stopping by {{company}}')).toEqual([]);
    });

    it('listSpintaxGroups still finds a real group alongside untouched merge fields', () => {
      const groups = listSpintaxGroups(
        'Hi {{firstName}}, {great to connect|nice to meet you} re {{company}}',
      );
      expect(groups).toEqual([['great to connect', 'nice to meet you']]);
    });
  });
});
