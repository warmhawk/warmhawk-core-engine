/**
 * Seed-Inbox Placement Test (Guardrails, V12) — pure folder-classification logic, factored out of
 * the IMAP-polling I/O (`seedPlacementPoller.ts`) so it's unit-testable without a real mailbox
 * connection, matching this repo's existing pattern (`imapClient.ts`'s `SPAM_FOLDER_CANDIDATES`
 * for the mailbox-side reply-poll logic).
 *
 * Deliberately conservative: an unrecognized folder name classifies as UNCLASSIFIED rather than
 * guessing INBOX or SPAM — the whole point of "placement sampling, honestly labeled" (per the
 * spec) is not overclaiming what was actually observed.
 */
import type { SeedPlacementFolder } from '@warmhawk/db';

/** Provider folder-naming conventions that mean "the message landed in the primary inbox." Most
 *  IMAP servers report the primary mailbox as `INBOX` regardless of provider, but Gmail's web UI
 *  "Primary" tab is still `INBOX` at the IMAP layer — Promotions/Social are separate labels, not
 *  separate INBOX names, which is exactly why they need their own candidate list below. */
const INBOX_FOLDER_CANDIDATES = ['inbox'];

/** Spam/junk folder names across Gmail, Outlook/Microsoft 365, Yahoo, and Zoho — mirrors (and is
 *  kept in sync with, by convention, not import — apps/api and this file are both `apps/api`, but
 *  the pattern is intentionally duplicated for the same reason `queue.ts` duplicates constants
 *  from `apps/worker`: this is a *sampling* concern, not the reply-poll concern `imapClient.ts`'s
 *  `SPAM_FOLDER_CANDIDATES` serves) `imapClient.ts`'s spam-folder list, extended with Yahoo/Zoho
 *  naming. */
const SPAM_FOLDER_CANDIDATES = [
  'spam',
  'junk',
  'junk email',
  '[gmail]/spam',
  'bulk mail', // Yahoo
  'bulk',
];

/** Gmail's "Promotions" category tab — the single most-cited placement failure mode in the
 *  competitor pain-point research this feature answers (Instantly's warmup score collapsing to
 *  "inbox" placement that's actually landing in Promotions, not truly Primary). */
const PROMOTIONS_FOLDER_CANDIDATES = [
  'promotions',
  '[gmail]/promotions',
  'categorypromotions',
  'category promotions',
];

/** Classifies a raw IMAP folder path (as reported by `ImapFlow#list()`) into one of the four
 *  placement-sampling outcomes. Case-insensitive, tolerant of provider-specific path prefixes
 *  (e.g. `[Gmail]/Promotions`). */
export function classifyFolder(folderPath: string): SeedPlacementFolder {
  const normalized = folderPath.trim().toLowerCase();

  if (PROMOTIONS_FOLDER_CANDIDATES.some((candidate) => normalized === candidate)) {
    return 'PROMOTIONS';
  }
  if (SPAM_FOLDER_CANDIDATES.some((candidate) => normalized === candidate)) {
    return 'SPAM';
  }
  if (INBOX_FOLDER_CANDIDATES.some((candidate) => normalized === candidate)) {
    return 'INBOX';
  }
  return 'UNCLASSIFIED';
}

export { SPAM_FOLDER_CANDIDATES, PROMOTIONS_FOLDER_CANDIDATES, INBOX_FOLDER_CANDIDATES };
