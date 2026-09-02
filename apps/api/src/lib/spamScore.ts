/**
 * Pre-send content quality scorer — new, V11 ("every 2026 competitor reviewed ships a free
 * pre-send spam-word/content scorer, both as a trust-building lead magnet and a real feature").
 * Heuristic, not a trained classifier: spam-trigger word/phrase list, excessive
 * punctuation/ALL-CAPS detection, link-count and urgency-language checks. Surfaced live in the
 * campaign builder as the customer types, in the licensed dashboard, computed here so both
 * the dashboard and a future public tool can call one function.
 */

/** Maintained spam-trigger word/phrase list — case-insensitive substring match. Not exhaustive;
 *  representative of the categories real spam filters weight heavily (urgency, money, free,
 *  pressure tactics). */
export const SPAM_TRIGGER_PHRASES = [
  'act now',
  'buy now',
  'click here',
  'free money',
  'guarantee',
  'guaranteed',
  'no obligation',
  'no credit check',
  'risk-free',
  'once in a lifetime',
  'limited time',
  'act immediately',
  'apply now',
  'cash bonus',
  'cancel at any time',
  'congratulations',
  'dear friend',
  'earn extra cash',
  'eliminate debt',
  'for only $',
  'get paid',
  'increase sales',
  'lowest price',
  'make money fast',
  'million dollars',
  'no cost',
  'no fees',
  'no purchase necessary',
  'order now',
  'special promotion',
  'winner',
  "you've been selected",
  'urgent',
  '100% free',
];

export interface SpamScoreIssue {
  category:
    'trigger_phrase' | 'all_caps' | 'excessive_punctuation' | 'link_count' | 'urgency_language';
  detail: string;
  points: number;
}

export interface SpamScoreResult {
  /** 0-100 heuristic score — higher means more likely to be filtered as spam. Not a probability. */
  score: number;
  issues: SpamScoreIssue[];
  /** Convenience banding for UI display. */
  band: 'low' | 'medium' | 'high';
}

const LINK_REGEX = /https?:\/\/\S+/gi;
const ALL_CAPS_WORD_REGEX = /\b[A-Z]{4,}\b/g;
const EXCESSIVE_PUNCTUATION_REGEX = /([!?])\1{1,}/g; // e.g. "!!" or "??"

/** Scores `content` (subject line + body, or either alone) heuristically for spam-trigger
 *  signals. Deterministic — same input always produces the same score, so it's safe to call on
 *  every keystroke in the campaign builder without surprising the customer. */
export function scoreContent(content: string): SpamScoreResult {
  const issues: SpamScoreIssue[] = [];
  const lower = content.toLowerCase();

  for (const phrase of SPAM_TRIGGER_PHRASES) {
    if (lower.includes(phrase)) {
      issues.push({
        category: 'trigger_phrase',
        detail: `Contains spam-trigger phrase: "${phrase}"`,
        points: 8,
      });
    }
  }

  const capsMatches = content.match(ALL_CAPS_WORD_REGEX) ?? [];
  // Common short acronyms shouldn't trip this — require length >= 4 already filters most, but
  // also ignore a small set of extremely common benign all-caps tokens.
  const benignAcronyms = new Set(['HTML', 'API', 'FAQ', 'CEO', 'CFO', 'CTO']);
  const suspiciousCaps = capsMatches.filter((word) => !benignAcronyms.has(word));
  if (suspiciousCaps.length > 0) {
    issues.push({
      category: 'all_caps',
      detail: `${suspiciousCaps.length} ALL-CAPS word(s) detected: ${suspiciousCaps.slice(0, 5).join(', ')}`,
      points: Math.min(suspiciousCaps.length * 5, 25),
    });
  }

  const punctuationMatches = content.match(EXCESSIVE_PUNCTUATION_REGEX) ?? [];
  if (punctuationMatches.length > 0) {
    issues.push({
      category: 'excessive_punctuation',
      detail: `${punctuationMatches.length} instance(s) of excessive punctuation (e.g. "!!", "??")`,
      points: Math.min(punctuationMatches.length * 5, 20),
    });
  }

  const linkMatches = content.match(LINK_REGEX) ?? [];
  if (linkMatches.length > 3) {
    issues.push({
      category: 'link_count',
      detail: `${linkMatches.length} links detected — more than 3 links raises spam-filter risk`,
      points: Math.min((linkMatches.length - 3) * 6, 24),
    });
  }

  const urgencyWords = [
    'urgent',
    'immediately',
    'hurry',
    'expires soon',
    "don't miss",
    'last chance',
  ];
  const urgencyHits = urgencyWords.filter((word) => lower.includes(word));
  if (urgencyHits.length > 0) {
    issues.push({
      category: 'urgency_language',
      detail: `Urgency language detected: ${urgencyHits.join(', ')}`,
      points: urgencyHits.length * 6,
    });
  }

  const rawScore = issues.reduce((sum, issue) => sum + issue.points, 0);
  const score = Math.min(100, rawScore);
  const band: SpamScoreResult['band'] = score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low';

  return { score, issues, band };
}
