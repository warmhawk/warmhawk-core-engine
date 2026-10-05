/**
 * What the person actually typed in a reply — the quoted original cut away.
 *
 * Every campaign email ends with our CAN-SPAM footer (`Unsubscribe: <url>`, see
 * `sendCompliance.ts#appendCanSpamFooter`), and most replies quote the email they answer. Feeding
 * the whole reply to the classifier therefore puts the word "unsubscribe" into almost every reply,
 * and the keyword fallback read that as an opt-out — blocking people who wrote "sounds good". The
 * AI prompt gets the stripped text too, so the model never weighs our own footer either.
 *
 * `Reply.rawContent` still stores the full reply; this is only what gets classified.
 */

/** A line that starts the quoted original: Gmail/Apple "On … wrote:", Outlook's separator lines. */
const QUOTE_START = [
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^_{10,}$/,
  /^-{2}\s?$/, // the "-- " signature marker, and the first line of our own footer
];

const WROTE_LINE = /\bwrote:$/i;
const OUTLOOK_HEADER = /^(sent|date|to|subject):\s/i;
/** Our footer's link line, however the replier's client re-rendered the URL. */
const FOOTER_UNSUBSCRIBE = /^unsubscribe:\s*[<[]?https?:\/\//i;

/** Index of the first line of the quoted original, or -1 when the reply quotes nothing. */
function quoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (QUOTE_START.some((re) => re.test(line))) return i;
    // Gmail wraps a long "On <date> <name> <address> wrote:" over two or three lines.
    if (/^on\s/i.test(line) && lines.slice(i, i + 3).some((l) => WROTE_LINE.test(l.trim()))) {
      return i;
    }
    // Outlook: "From: …" followed by Sent/Date/To/Subject header lines.
    if (
      /^from:\s/i.test(line) &&
      lines.slice(i + 1, i + 5).some((l) => OUTLOOK_HEADER.test(l.trim()))
    ) {
      return i;
    }
  }
  return -1;
}

export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const notQuoted = (line: string) =>
    !line.trimStart().startsWith('>') && !FOOTER_UNSUBSCRIBE.test(line.trim());

  const start = quoteStart(lines);
  const top = (start === -1 ? lines : lines.slice(0, start)).filter(notQuoted).join('\n').trim();
  if (top) return top;

  // Nothing above the quote: an inline reply written between the quoted lines. Keep every line
  // that isn't itself quoted, minus the quote-header lines.
  return lines
    .filter((line, i) => i !== start && notQuoted(line) && !WROTE_LINE.test(line.trim()))
    .join('\n')
    .trim();
}
