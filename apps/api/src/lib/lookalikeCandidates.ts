/**
 * Lookalike/typosquat candidate generator — Item 6 (Tier-2-only lookalike domain monitoring; see
 * `packages/db/prisma/schema.prisma`'s `LookalikeCandidate` model doc comment for the full
 * feature). Pure, deterministic, **no network calls** — this only produces the list of candidate
 * strings a caller (the `POST /internal/domains/scan-lookalikes` route) later checks against RDAP
 * via `lib/rdap.ts`. Kept as a plain function file rather than its own workspace package, per
 * instruction — nothing else in this repo needs it yet.
 *
 * Standard, well-documented typosquat-generation technique categories, each producing plausible
 * real-world confusables for a domain like `example.com`:
 *
 *  - **Character swap** — two adjacent letters transposed (`exmaple.com`).
 *  - **Omission** — one character dropped (`exampl.com`).
 *  - **Insertion** — one character (a QWERTY-adjacent key of its neighbor) duplicated/inserted
 *    (`exampple.com`).
 *  - **Adjacent-keyboard substitution** — one character replaced with its QWERTY neighbor
 *    (`ecample.com` — `x` is adjacent to `c` and `z` on a QWERTY row).
 *  - **TLD swap** — same second-level name, a different common TLD (`example.net`, `.co`, `.org`).
 *  - **Homoglyph substitution** — a visually similar digit swapped in for a letter
 *    (`examp1e.com` — digit `1` for letter `l`).
 *
 * Output is deduped and never includes the original domain itself.
 */

/** QWERTY physical-adjacency map, lowercase letters only — used for both the adjacent-key
 *  substitution category and as the insertion category's source of "a plausible nearby key" so an
 *  inserted character reads as a real fat-finger mistake rather than an arbitrary letter. */
const QWERTY_ADJACENCY: Record<string, string[]> = {
  q: ['w', 'a'],
  w: ['q', 'e', 's'],
  e: ['w', 'r', 'd'],
  r: ['e', 't', 'f'],
  t: ['r', 'y', 'g'],
  y: ['t', 'u', 'h'],
  u: ['y', 'i', 'j'],
  i: ['u', 'o', 'k'],
  o: ['i', 'p', 'l'],
  p: ['o', 'l'],
  a: ['q', 's', 'z'],
  s: ['a', 'd', 'w', 'z'],
  d: ['s', 'f', 'e', 'c'],
  f: ['d', 'g', 'r', 'v'],
  g: ['f', 'h', 't', 'b'],
  h: ['g', 'j', 'y', 'n'],
  j: ['h', 'k', 'u', 'm'],
  k: ['j', 'l', 'i'],
  l: ['k', 'o', 'p'],
  z: ['a', 's', 'x'],
  x: ['z', 'c', 'd'],
  c: ['x', 'v', 'd', 'f'],
  v: ['c', 'b', 'f', 'g'],
  b: ['v', 'n', 'g', 'h'],
  n: ['b', 'm', 'h', 'j'],
  m: ['n', 'j', 'k'],
};

/** Digit-for-letter homoglyphs commonly used in phishing/typosquat registrations. */
const HOMOGLYPH_MAP: Record<string, string> = {
  l: '1',
  i: '1',
  o: '0',
  e: '3',
  a: '4',
  s: '5',
  g: '9',
  b: '8',
};

/** Common TLDs swapped in for whatever TLD the input domain already has, per the doc's example
 *  (`example.net`, `example.co`, `example.org`). */
const COMMON_TLD_SWAPS = ['com', 'net', 'org', 'co', 'io'];

interface ParsedDomain {
  /** Everything before the last dot, e.g. "example" for "example.com". */
  name: string;
  /** Everything after the last dot, e.g. "com" for "example.com". */
  tld: string;
}

function parseDomain(domain: string): ParsedDomain {
  const lower = domain.trim().toLowerCase();
  const lastDot = lower.lastIndexOf('.');
  if (lastDot === -1) return { name: lower, tld: '' };
  return { name: lower.slice(0, lastDot), tld: lower.slice(lastDot + 1) };
}

function characterSwaps(name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < name.length - 1; i += 1) {
    if (name[i] === name[i + 1]) continue; // swapping identical adjacent chars is a no-op
    const chars = name.split('');
    [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
    results.push(chars.join(''));
  }
  return results;
}

function omissions(name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < name.length; i += 1) {
    results.push(name.slice(0, i) + name.slice(i + 1));
  }
  return results;
}

function insertions(name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < name.length; i += 1) {
    // Double-keystroke — the character itself repeated (e.g. "example" -> "exampple"), the most
    // common real-world insertion typo.
    results.push(name.slice(0, i + 1) + name[i] + name.slice(i + 1));
    // A QWERTY-adjacent key inserted next to the character it neighbors.
    const neighbors = QWERTY_ADJACENCY[name[i]] ?? [];
    for (const neighbor of neighbors) {
      results.push(name.slice(0, i) + neighbor + name.slice(i));
    }
  }
  return results;
}

function adjacentKeySubstitutions(name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < name.length; i += 1) {
    const neighbors = QWERTY_ADJACENCY[name[i]] ?? [];
    for (const neighbor of neighbors) {
      results.push(name.slice(0, i) + neighbor + name.slice(i + 1));
    }
  }
  return results;
}

function homoglyphSubstitutions(name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < name.length; i += 1) {
    const replacement = HOMOGLYPH_MAP[name[i]];
    if (!replacement) continue;
    results.push(name.slice(0, i) + replacement + name.slice(i + 1));
  }
  return results;
}

function tldSwaps(name: string, currentTld: string): string[] {
  return COMMON_TLD_SWAPS.filter((tld) => tld !== currentTld).map((tld) => `${name}.${tld}`);
}

/**
 * Generates typosquat/lookalike candidate domains for `domain`, deduped, excluding `domain`
 * itself. Pure — no network calls.
 */
export function generateCandidates(domain: string): string[] {
  const { name, tld } = parseDomain(domain);
  const original = tld ? `${name}.${tld}` : name;

  const nameVariants = [
    ...characterSwaps(name),
    ...omissions(name),
    ...insertions(name),
    ...adjacentKeySubstitutions(name),
    ...homoglyphSubstitutions(name),
  ];

  const candidates = new Set<string>();
  for (const variant of nameVariants) {
    if (!variant || variant === name) continue;
    candidates.add(tld ? `${variant}.${tld}` : variant);
  }
  for (const candidate of tldSwaps(name, tld)) {
    candidates.add(candidate);
  }

  candidates.delete(original);
  return Array.from(candidates);
}
