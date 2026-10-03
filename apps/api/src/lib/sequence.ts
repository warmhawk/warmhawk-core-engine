/**
 * Follow-up sequences — the rules both the send path and the campaign routes share.
 *
 * A campaign's first email is `Campaign.template`/`subject`; follow-ups are `CampaignStep` rows,
 * position 1..MAX_FOLLOW_UPS. `Lead.stepsSent` counts emails already sent to the lead, so the next
 * one is follow-up `stepsSent` (0 = the first email). Every follow-up goes from the lead's pinned
 * mailbox, as a reply in the same thread, and never after a reply, bounce or unsubscribe.
 */

export const MAX_FOLLOW_UPS = 3;
export const MIN_WAIT_DAYS = 1;
export const MAX_WAIT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SequenceStep {
  position: number;
  waitDays: number;
  body: string;
  aiRewrite: boolean;
}

/** The follow-up due after `stepsSent` emails, or null when the sequence is done. */
export function nextFollowUp<T extends Pick<SequenceStep, 'position'>>(
  steps: T[],
  stepsSent: number,
): T | null {
  if (stepsSent < 1) return null;
  return steps.find((s) => s.position === stepsSent) ?? null;
}

/** When the next follow-up is due, counted from the email just sent; null when none is left. */
export function nextStepAtAfter(
  steps: Pick<SequenceStep, 'position' | 'waitDays'>[],
  stepsSent: number,
  sentAt: Date,
): Date | null {
  const next = nextFollowUp(steps, stepsSent);
  return next ? new Date(sentAt.getTime() + next.waitDays * DAY_MS) : null;
}

/** "Re: <first subject>", without stacking a second "Re:" on a subject that already has one. */
export function followUpSubject(threadSubject: string): string {
  return `Re: ${threadSubject.replace(/^\s*(re|aw|sv):\s*/i, '').trim()}`;
}

/** True when a subject template renders the same for every lead every time — no spintax. Merge
 *  fields are fine (they fill the same way again). Used to rebuild the thread subject for a lead
 *  sent before `Lead.threadSubject` was kept. */
export function isDeterministicSubject(subject: string | null): boolean {
  if (!subject?.trim()) return false;
  const withoutMergeFields = subject.replace(/\{\{[^{}]*\}\}/g, '');
  return !/\{[^{}]*\|[^{}]*\}/.test(withoutMergeFields);
}

export interface StepInput {
  waitDays?: unknown;
  body?: unknown;
  aiRewrite?: unknown;
}

/** Validates a full replacement list of follow-ups from the dashboard. Bodies may be empty while
 *  the campaign is a draft — the launch check is what refuses an empty one. */
export function parseStepsInput(
  input: unknown,
): { ok: true; steps: SequenceStep[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'steps must be an array' };
  if (input.length > MAX_FOLLOW_UPS)
    return { ok: false, error: `At most ${MAX_FOLLOW_UPS} follow-ups` };
  const steps: SequenceStep[] = [];
  for (const [i, raw] of (input as StepInput[]).entries()) {
    const waitDays = Number(raw?.waitDays);
    if (!Number.isInteger(waitDays) || waitDays < MIN_WAIT_DAYS || waitDays > MAX_WAIT_DAYS) {
      return {
        ok: false,
        error: `Follow-up ${i + 1}: wait must be ${MIN_WAIT_DAYS}–${MAX_WAIT_DAYS} days`,
      };
    }
    if (raw?.body !== undefined && typeof raw.body !== 'string') {
      return { ok: false, error: `Follow-up ${i + 1}: body must be text` };
    }
    const body = typeof raw?.body === 'string' ? raw.body : '';
    if (body.length > 20_000) return { ok: false, error: `Follow-up ${i + 1}: body is too long` };
    steps.push({ position: i + 1, waitDays, body, aiRewrite: raw?.aiRewrite === true });
  }
  return { ok: true, steps };
}
