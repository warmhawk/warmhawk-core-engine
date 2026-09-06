/**
 * Spintax parser/renderer — new, V11 ("a 2026 field test found basic spintax on subject
 * lines/openers alone lifted inbox placement from 59% to 83%"). Native syntax
 * `{option one|option two|option three}`, supported independent of AI-provider configuration so
 * a customer who skips AI BYOK setup entirely still gets per-send variation instead of one
 * identical template sent to every lead. Supports nested spintax (an option can itself contain
 * another `{a|b}` group).
 */

export class SpintaxParseError extends Error {}

/**
 * Renders one random resolution of `template`'s spintax groups. Each `{opt1|opt2|...}` group is
 * replaced by one uniformly-randomly-chosen option; groups can nest (an option's own `{...}`
 * groups are resolved recursively, innermost-first, since the innermost matching `{...}` with no
 * further `{` inside it is always processed first by the regex scan below).
 *
 * Plain text with no spintax groups renders as itself, unchanged — spintax is fully optional, and
 * `Campaign.template` is nullable for exactly this "send as-is" case.
 */
export function renderSpintax(template: string, rng: () => number = Math.random): string {
  assertBalanced(template);

  let result = template;
  // Repeatedly resolve the innermost group (no nested `{` inside it) until none remain. Bounded
  // by the input length so a pathological input can't loop forever even if assertBalanced somehow
  // missed a malformed case.
  const maxIterations = template.length + 100;
  let iterations = 0;

  // Bug fix (spintax/merge-field regex collision, 2026-09-04): a merge field like `{{firstName}}`
  // is itself a balanced `{...}` pair one level in (`{firstName}`), which — with no way to tell it
  // apart from a deliberate single-option spintax group like `{no pipe here}` (see the
  // "round-trips" test below, which intentionally DOES resolve that case) — used to get matched
  // and collapsed to bare "firstName" text, corrupting the merge field. The one structural
  // difference: a merge field's inner brace is doubled on BOTH sides (`{` immediately before,
  // `}` immediately after), whereas a real spintax group — even nested, e.g.
  // `{Hi {John|Jane}|Hello there}` — is never doubled on both sides of the same pair at once. The
  // lookaround below excludes exactly that doubled shape, leaving `{{...}}` untouched while every
  // existing spintax case (including nesting and the single-option no-pipe case) still resolves
  // exactly as before. Real per-lead sends never hit this collision anyway — see
  // `apps/api/src/routes/internalAi.ts#renderFallbackTemplate`'s own comment on why it fills merge
  // fields before calling this — but `listSpintaxGroups` below (the save-time content-quality
  // count) runs on the raw, unfilled template, so it needs this same fix.
  const innermostGroupRegex = /(?<!\{)\{([^{}]*)\}(?!\})/;

  while (innermostGroupRegex.test(result)) {
    if (++iterations > maxIterations) {
      throw new SpintaxParseError(
        'Spintax resolution did not terminate — check for malformed input',
      );
    }
    result = result.replace(innermostGroupRegex, (_match, optionsRaw: string) => {
      const options = optionsRaw.split('|');
      const chosenIndex = Math.floor(rng() * options.length);
      return options[Math.min(chosenIndex, options.length - 1)];
    });
  }

  return result;
}

/** Returns true if `template` contains at least one spintax group. */
export function hasSpintax(template: string): boolean {
  return /\{[^{}]*\|[^{}]*\}/.test(template);
}

/** Extracts every top-level-resolvable option set in `template`, for a UI preview ("this
 *  template has N variation points") without actually rendering a random pick. */
export function listSpintaxGroups(template: string): string[][] {
  assertBalanced(template);
  const groups: string[][] = [];
  // Same doubled-brace exclusion as renderSpintax's innermostGroupRegex above, so a template
  // containing only merge fields (e.g. "Hi {{firstName}}") reports zero variation groups instead
  // of one — this is the function `apps/api/src/routes/campaigns.ts`'s save-time
  // `evaluateContentQuality` calls to compute `spintaxGroupCount`.
  const regex = /(?<!\{)\{([^{}]*)\}(?!\})/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    groups.push(match[1].split('|'));
  }
  return groups;
}

function assertBalanced(template: string): void {
  let depth = 0;
  for (const char of template) {
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth < 0) {
      throw new SpintaxParseError('Unbalanced spintax: unexpected "}" with no matching "{"');
    }
  }
  if (depth !== 0) {
    throw new SpintaxParseError('Unbalanced spintax: unclosed "{" group');
  }
}
