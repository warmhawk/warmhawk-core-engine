/**
 * Warmup engine — writes the warmup emails themselves. Short, plain, ordinary business notes with
 * no tracking token in the subject or body: mailbox providers learn to recognize warmup traffic by
 * exactly that kind of fixed marker, so the engine finds each email by its Message-ID instead
 * (see placement.ts). Randomness is injected so tests can pin the output.
 */

export type Rng = () => number;

const SUBJECTS = [
  'Quick question about next week',
  'Following up on our chat',
  'Notes from today',
  'Checking in',
  'Re: the schedule',
  'Thoughts on the draft',
  'A small update',
  'Can we move Thursday?',
  'Thanks for the help',
  'Planning for next month',
  'One more thing',
  'Catching up',
  'About the proposal',
  'Your feedback on this?',
  'Next steps',
];

const GREETINGS = ['Hi', 'Hello', 'Hey', 'Good morning', 'Hi there'];

const OPENERS = [
  'Hope your week is going well.',
  'Thanks again for getting back to me so quickly.',
  'I wanted to follow up on what we talked about.',
  'Just a quick note before the end of the day.',
  'I had a chance to look things over this morning.',
  'Hope you had a good weekend.',
];

const MIDDLES = [
  'Would Tuesday or Wednesday afternoon work better for a short call?',
  'I put together a few notes and will share them once they are cleaned up.',
  'The timeline still looks fine on our side, so no changes needed for now.',
  'Let me know if anything on the list looks off to you.',
  'I think we can keep the scope as it is and revisit it next month.',
  'Could you send over the latest version when you get a minute?',
  'Happy to go through the details whenever it suits you.',
  'Nothing urgent here, just wanted to keep you in the loop.',
];

const CLOSINGS = ['Thanks,', 'Best,', 'Cheers,', 'Talk soon,', 'Regards,', 'Thank you,'];

function pick<T>(items: readonly T[], rng: Rng): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

/** "jordan.t@acme.example" -> "Jordan". Falls back to nothing for role addresses. */
export function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._+-]/)[0] ?? '';
  if (
    !first ||
    /^(info|hello|hi|admin|support|sales|team|contact|noreply|no-reply|mail)$/i.test(first)
  ) {
    return '';
  }
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

export interface WarmupEmail {
  subject: string;
  body: string;
}

export function composeWarmupEmail(params: {
  fromEmail: string;
  toEmail: string;
  rng?: Rng;
}): WarmupEmail {
  const rng = params.rng ?? Math.random;
  const toName = displayNameFromEmail(params.toEmail);
  const fromName = displayNameFromEmail(params.fromEmail);

  const greeting = pick(GREETINGS, rng);
  const opener = pick(OPENERS, rng);
  const middle = pick(MIDDLES, rng);
  const closing = pick(CLOSINGS, rng);

  const lines = [
    toName ? `${greeting} ${toName},` : `${greeting},`,
    '',
    `${opener} ${middle}`,
    '',
    closing,
  ];
  if (fromName) lines.push(fromName);

  return { subject: pick(SUBJECTS, rng), body: lines.join('\n') };
}
