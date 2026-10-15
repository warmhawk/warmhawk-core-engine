/**
 * Reading a failed send's error, shared by the API (which records it) and the worker (which slows
 * a mailbox down after one). Google's sender guidelines: "If messages start bouncing or start being
 * deferred, reduce the sending volume until the SMTP error rate decreases."
 */

/** The sending provider says "too much, not now": a daily quota, a rate limit, too many
 *  connections. Gmail answers its daily limit with a 550 5.4.5, so a 5xx alone doesn't make a
 *  bounce — the lead is fine, the mailbox has to wait. */
const SENDING_LIMIT =
  /\b5\.4\.5\b|\b4\.7\.(0|28)\b|quota|sending limit|limit exceeded|rate limit|too many|throttl/i;

/** A temporary refusal: a 4xx reply, or the words servers use for one. A port (":465") or an IP
 *  part isn't a reply code. */
const TEMPORARY =
  /(?<![:.\d])\b4[2-5]\d\b(?![.:]\d)|\b4\.\d{1,3}\.\d{1,3}\b|try again later|temporar|deferr/i;

export function isSendingLimit(message: string | null | undefined): boolean {
  return Boolean(message && SENDING_LIMIT.test(message));
}

/** A failed send the mailbox should answer by slowing down. Not the pre-send address check's
 *  "Not sent:" rows: nothing left the mailbox for those. */
export function isDeferral(message: string | null | undefined): boolean {
  if (!message || message.startsWith('Not sent:')) return false;
  return isSendingLimit(message) || TEMPORARY.test(message);
}
