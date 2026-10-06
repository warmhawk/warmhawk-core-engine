/**
 * Checks on what the model sent back, against the campaign's own email it was given. Found in the
 * 2026-10-06 test of six real campaigns on both providers:
 *  - AI Writes dropped the signup link (`jitterflow.io/signup?ref=…`) and the price ($499.50 setup,
 *    $99.50 a month) from most emails, which changes the offer the sender wrote.
 *  - AI Adjusts sometimes reworded the sender's sentences, and Gemini ran the added line into the
 *    greeting with no blank line between them.
 * Prompt wording lowers how often this happens; these checks catch it when it still does.
 */

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi;
// A bare web address such as `warmhawk.com`. Needs two letters after the last dot, so "e.g." and
// "J. Molina" don't count.
const DOMAIN_PATTERN = /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b/gi;
const MONEY_PATTERN =
  /[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP)\b|\b\d+(?:\.\d+)?\s?%/gi;

function trimTrailingPunctuation(text: string): string {
  return text.replace(/[.,;:!?]+$/, '');
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The links, web addresses, prices and percentages in the sender's email — what the AI must
 *  carry over as written. A domain that is part of a link counts once, as the link. */
export function factsToKeep(email: string): string[] {
  const urls = (email.match(URL_PATTERN) ?? []).map(trimTrailingPunctuation);
  const rest = email.replace(URL_PATTERN, ' ');
  const domains = (rest.match(DOMAIN_PATTERN) ?? []).filter(
    (d) => !urls.some((u) => u.toLowerCase().includes(d.toLowerCase())),
  );
  const money = (rest.match(MONEY_PATTERN) ?? []).map((m) => m.replace(/\s+/g, ''));
  return [...new Set([...urls, ...domains, ...money])];
}

/** Which of `factsToKeep(email)` the AI's text left out. Case and spacing don't count. */
export function missingFacts(email: string, written: string): string[] {
  const text = squash(written).replace(/\s+/g, '');
  return factsToKeep(email).filter(
    (fact) => !text.includes(fact.toLowerCase().replace(/\s+/g, '')),
  );
}

/** Links in the AI's text that the sender's email doesn't have. Lead lists carry links of their
 *  own (`stateRuleUrl`), and Gemini put one into an AI Writes email that asks "Want me to send
 *  it?" — a link the sender left out of a first email. Bare web addresses don't count: naming the
 *  lead's own domain is fine. */
export function addedLinks(email: string, written: string): string[] {
  const base = email.toLowerCase();
  const urls = (written.match(URL_PATTERN) ?? []).map(trimTrailingPunctuation);
  return [...new Set(urls)].filter((url) => !base.includes(url.toLowerCase()));
}

/** AI Adjusts with the default instructions adds one sentence and keeps every line of the
 *  sender's email word for word. Returns the lines it changed or left out. The added sentence may
 *  share a line with one of the sender's, so a line only has to appear somewhere in the text. */
export function changedLines(email: string, written: string): string[] {
  const text = squash(written);
  return email
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !text.includes(squash(line)));
}

/** Puts back the blank lines the model dropped between the sender's paragraphs — Gemini wrote its
 *  added sentence on the line right under "Hi there,". A blank line goes between two lines of the
 *  AI's text where the sender's email had one after the first or before the second. */
export function restoreParagraphBreaks(email: string, written: string): string {
  const base = email.split('\n').map((line) => squash(line));
  const blankAfter = new Set<string>();
  const blankBefore = new Set<string>();
  base.forEach((line, i) => {
    if (!line) return;
    if (i + 1 < base.length && !base[i + 1]) blankAfter.add(line);
    if (i > 0 && !base[i - 1]) blankBefore.add(line);
  });
  const out: string[] = [];
  for (const line of written.split('\n')) {
    const prev = out.at(-1);
    if (
      prev !== undefined &&
      prev.trim() &&
      line.trim() &&
      (blankAfter.has(squash(prev)) || blankBefore.has(squash(line)))
    ) {
      out.push('');
    }
    out.push(line);
  }
  return out.join('\n');
}

// An email provider's name in the company field means the lead has no company on record — a
// LeadHound list had "Gmail" as the company on 94 of 243 leads, and the AI wrote "at Gmail".
const FREE_MAIL_COMPANIES = new Set([
  'gmail',
  'googlemail',
  'yahoo',
  'ymail',
  'outlook',
  'hotmail',
  'live',
  'msn',
  'aol',
  'icloud',
  'me',
  'mac',
  'proton',
  'protonmail',
  'gmx',
  'yandex',
  'zoho',
  'mail',
]);

export function isFreeMailCompany(company: unknown): boolean {
  if (typeof company !== 'string') return false;
  const name = company
    .trim()
    .toLowerCase()
    .replace(/\.(com|net|de|co\.uk|fr|ru|me)$/, '');
  return FREE_MAIL_COMPANIES.has(name);
}
