/**
 * Unit tests for the AI-compose pieces that need no database: the prompt the model gets per mode,
 * the `Subject:` parser, failure classification, the legacy first-line subject rule, and the
 * sender-name fallback. `composeCampaignEmail` itself (provider-key lookup, subject precedence end
 * to end) is covered in `integration/internalAiPersonalize.integration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPersonalizationPrompt,
  parseGeneratedEmail,
  classifyAiFailure,
  DEFAULT_PERSONALIZE_INSTRUCTIONS,
  DEFAULT_PROMPT_INSTRUCTIONS,
  stripPlaceholders,
} from '../../lib/aiProviderClient';
import {
  splitLegacySubject,
  resolveSenderName,
  buildLeadContext,
} from '../../lib/composeCampaignEmail';

const leadContext = { firstName: 'Dana', company: 'Acme Logistics' };

describe('buildPersonalizationPrompt', () => {
  it('PERSONALIZE hands the model the rendered email and tells it to keep the rest word for word', () => {
    const prompt = buildPersonalizationPrompt({
      mode: 'PERSONALIZE',
      promptTemplate: 'Rewrite the first line for {{company}}.',
      baseEmail: 'Hi Dana,\n\nWe cut dispatch time by 30%.\n\nBest, Sam',
      leadContext,
    });
    expect(prompt).toContain(
      '<email>\nHi Dana,\n\nWe cut dispatch time by 30%.\n\nBest, Sam\n</email>',
    );
    expect(prompt).toContain('Instructions: Rewrite the first line for Acme Logistics.');
    expect(prompt).toContain('Keep every other sentence word for word');
  });

  it('PERSONALIZE with blank instructions defaults to tailoring the opening line', () => {
    const prompt = buildPersonalizationPrompt({
      mode: 'PERSONALIZE',
      promptTemplate: '  ',
      baseEmail: 'Hi Dana,',
      leadContext,
    });
    expect(prompt).toContain(`Instructions: ${DEFAULT_PERSONALIZE_INSTRUCTIONS}`);
  });

  it('PERSONALIZE with no email to adjust falls back to PROMPT behavior', () => {
    const prompt = buildPersonalizationPrompt({
      mode: 'PERSONALIZE',
      promptTemplate: 'Write a short intro to {{firstName}}.',
      baseEmail: '',
      leadContext,
    });
    expect(prompt).not.toContain('<email>');
    expect(prompt.startsWith('Write a short intro to Dana.')).toBe(true);
  });

  it("PROMPT writes from the campaign's own email as the source of the offer, not a copy of it", () => {
    const prompt = buildPersonalizationPrompt({
      mode: 'PROMPT',
      promptTemplate: 'Write a short intro.',
      baseEmail: 'Hi Dana, we cut dispatch time by 30%.',
      leadContext,
    });
    expect(prompt.startsWith('Write a short intro.')).toBe(true);
    expect(prompt).toContain(
      '<sender_email>\nHi Dana, we cut dispatch time by 30%.\n</sender_email>',
    );
    expect(prompt).toContain("add no product, claim, number or meeting time it doesn't have");
    expect(prompt).not.toContain('word for word');
  });

  it('PROMPT with blank instructions writes from the email with the default instructions', () => {
    const prompt = buildPersonalizationPrompt({
      mode: 'PROMPT',
      promptTemplate: '',
      baseEmail: 'Hi Dana, we cut dispatch time by 30%.',
      leadContext,
    });
    expect(prompt.startsWith(DEFAULT_PROMPT_INSTRUCTIONS)).toBe(true);
  });

  it("PROMPT signs as the sender, and says to sign with no name when there isn't one", () => {
    const base = { mode: 'PROMPT' as const, promptTemplate: 'Write.', baseEmail: 'Hi Dana' };
    expect(
      buildPersonalizationPrompt({ ...base, leadContext: { ...leadContext, senderName: 'Sam' } }),
    ).toContain('Sign the email as Sam.');
    expect(buildPersonalizationPrompt({ ...base, leadContext })).toContain(
      'if there is none, end without a name',
    );
  });

  it('every mode forbids square-bracket placeholders', () => {
    for (const mode of ['PROMPT', 'PERSONALIZE'] as const) {
      expect(
        buildPersonalizationPrompt({ mode, promptTemplate: '', baseEmail: 'Hi Dana', leadContext }),
      ).toContain('Never write a placeholder in square brackets');
    }
  });

  it('asks for a Subject: first line only when the campaign wants one', () => {
    const base = { mode: 'PROMPT' as const, promptTemplate: 'Write.', leadContext };
    expect(buildPersonalizationPrompt({ ...base, wantsSubject: true })).toContain(
      '"Subject: <subject line>"',
    );
    expect(buildPersonalizationPrompt({ ...base, wantsSubject: false })).toContain(
      'no subject line',
    );
  });
});

describe('stripPlaceholders', () => {
  it("fills [Your Name] with the sender's name", () => {
    expect(stripPlaceholders('Hi Dana,\n\nBody.\n\nBest regards,\n[Your Name]', 'Sam')).toBe(
      'Hi Dana,\n\nBody.\n\nBest regards,\nSam',
    );
  });

  it('drops a placeholder-only line when there is no sender name', () => {
    expect(stripPlaceholders('Body.\n\nBest,\n[Your Name]\n[Your Title]', null)).toBe(
      'Body.\n\nBest,',
    );
  });

  it('takes a placeholder out of a sentence and leaves real brackets alone', () => {
    expect(stripPlaceholders('We help [Company Name] teams [fast].', null)).toBe(
      'We help teams [fast].',
    );
  });
});

describe('parseGeneratedEmail', () => {
  it('splits a Subject: first line off the body', () => {
    expect(parseGeneratedEmail('Subject: Faster dispatch at Acme\n\nHi Dana,\n\nBody.')).toEqual({
      subject: 'Faster dispatch at Acme',
      body: 'Hi Dana,\n\nBody.',
    });
  });

  it('tolerates markdown decorations models add', () => {
    expect(parseGeneratedEmail('**Subject:** Faster dispatch\n\nHi').subject).toBe(
      'Faster dispatch',
    );
    expect(parseGeneratedEmail('**Subject**: Faster dispatch\nHi').subject).toBe('Faster dispatch');
    expect(parseGeneratedEmail('Subject line: Faster dispatch\nHi').subject).toBe(
      'Faster dispatch',
    );
  });

  it('returns a null subject and the whole text when there is no Subject: line', () => {
    expect(parseGeneratedEmail('Hi Dana,\n\nBody.')).toEqual({
      subject: null,
      body: 'Hi Dana,\n\nBody.',
    });
  });

  it('does not treat a later "Subject:" line as the subject', () => {
    expect(parseGeneratedEmail('Hi Dana,\nSubject: nope').subject).toBeNull();
  });
});

describe('classifyAiFailure', () => {
  it.each([
    ['Gemini generateContent failed with HTTP 404: not found', 'model_unavailable'],
    ['Claude messages call failed with HTTP 401: invalid x-api-key', 'key_rejected'],
    ['Gemini generateContent failed with HTTP 403: permission denied', 'key_rejected'],
    ['Gemini generateContent failed with HTTP 503: overloaded', 'provider_error'],
    ['Gemini generateContent failed with HTTP 429: RESOURCE_EXHAUSTED', 'quota_exceeded'],
    ['Gemini generateContent failed with HTTP 400: {"reason": "API_KEY_INVALID"}', 'key_rejected'],
    ['Claude messages call failed with HTTP 400: Your credit balance is too low', 'quota_exceeded'],
    ['Gemini generateContent failed with HTTP 400: invalid argument', 'provider_error'],
    ['The operation was aborted', 'provider_error'],
  ])('%s → %s', (message, reason) => {
    expect(classifyAiFailure(new Error(message))).toBe(reason);
  });
});

describe('splitLegacySubject', () => {
  it('uses a short first line as the subject and takes it off the body', () => {
    expect(splitLegacySubject('Quick idea\nHi Dana,\nBody')).toEqual({
      subject: 'Quick idea',
      body: 'Hi Dana,\nBody',
    });
  });

  it('falls back to a generic subject for a one-line email', () => {
    expect(splitLegacySubject('Hi Dana, one line only.')).toEqual({
      subject: 'Quick question',
      body: 'Hi Dana, one line only.',
    });
  });
});

describe('resolveSenderName', () => {
  it('prefers the mailbox sender name', () => {
    expect(resolveSenderName({ email: 'sam@acme.example', senderName: ' Sam Patel ' })).toBe(
      'Sam Patel',
    );
  });

  it('falls back to a capitalised first token of the local part', () => {
    expect(resolveSenderName({ email: 'sam.patel@acme.example', senderName: null })).toBe('Sam');
  });

  it('is null with no mailbox', () => {
    expect(resolveSenderName(null)).toBeNull();
  });
});

describe('buildLeadContext', () => {
  it('includes email and senderName, and custom fields win over nothing', () => {
    expect(
      buildLeadContext(
        {
          email: 'dana@acme.example',
          firstName: 'Dana',
          lastName: null,
          company: 'Acme',
          customFields: { title: 'COO' },
        },
        'Sam',
      ),
    ).toEqual({
      firstName: 'Dana',
      lastName: null,
      company: 'Acme',
      email: 'dana@acme.example',
      senderName: 'Sam',
      title: 'COO',
    });
  });
});
