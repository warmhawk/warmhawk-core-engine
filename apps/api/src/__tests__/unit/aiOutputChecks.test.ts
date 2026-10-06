/**
 * Unit tests for the checks on what the model sends back (`lib/aiOutputChecks.ts`) and the
 * retry-then-fall-back around them (`personalizeChecked`). The emails are trimmed copies of what the
 * 2026-10-06 six-campaign test saw both providers do: AI Writes dropping the price and the signup
 * link, AI Adjusts rewording the sender's lines and running its sentence into the greeting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  addedLinks,
  changedLines,
  factsToKeep,
  isFreeMailCompany,
  missingFacts,
  restoreParagraphBreaks,
} from '../../lib/aiOutputChecks';
import * as aiProviderClient from '../../lib/aiProviderClient';
import { personalizeChecked } from '../../lib/composeCampaignEmail';

vi.mock('../../lib/aiProviderClient', async () => {
  const actual = await vi.importActual<typeof aiProviderClient>('../../lib/aiProviderClient');
  return { ...actual, personalizeContent: vi.fn() };
});

const OFFER =
  'Hi there,\n\n' +
  'If PowerUs sends its own cold email, WarmHawk keeps those mailboxes out of spam.\n\n' +
  'The first 15 clients pay half: $499.50 setup and $99.50 a month. Check your domain free first at warmhawk.com.\n\n' +
  'Worth a look?\n\nBest,\nSanthi T.';

const SIGNUP =
  'Hi there,\n\nThe Developer plan is free for life: 3 endpoints, no card. https://jitterflow.io/signup?ref=lh-npm\n\nSanthi T.';

describe('factsToKeep', () => {
  it('finds links, bare web addresses and prices', () => {
    expect(factsToKeep(OFFER)).toEqual(['warmhawk.com', '$499.50', '$99.50']);
    expect(factsToKeep(SIGNUP)).toEqual(['https://jitterflow.io/signup?ref=lh-npm']);
  });

  it('counts percentages, and leaves out initials and abbreviations', () => {
    expect(factsToKeep('We cut it by 30%. Ask J. Molina, e.g. today.')).toEqual(['30%']);
  });
});

describe('missingFacts', () => {
  it('lists the price an AI Writes email left out', () => {
    const written =
      'Hi there,\n\nWarmHawk runs warm-up on your own server. Check your domain at warmhawk.com.\n\nWorth a look?';
    expect(missingFacts(OFFER, written)).toEqual(['$499.50', '$99.50']);
  });

  it('lists a dropped signup link, and ignores case', () => {
    expect(missingFacts(SIGNUP, 'Hi there, try the free plan.')).toEqual([
      'https://jitterflow.io/signup?ref=lh-npm',
    ]);
    expect(missingFacts(OFFER, OFFER.replace('warmhawk.com', 'WarmHawk.com'))).toEqual([]);
  });
});

describe('addedLinks', () => {
  it("lists a link from the lead's data the sender's email doesn't have", () => {
    const email = 'Hi Helen,\n\nI put together a one-page summary. Want me to send it?';
    const written =
      'Hi Helen,\n\nMy summary is at https://clientsafeai.com/guides/aba-formal-opinion-512. Want me to send it?';
    expect(addedLinks(email, written)).toEqual([
      'https://clientsafeai.com/guides/aba-formal-opinion-512',
    ]);
  });

  it("passes the sender's own link and a bare web address", () => {
    expect(addedLinks(SIGNUP, SIGNUP)).toEqual([]);
    expect(addedLinks(OFFER, OFFER.replace('Hi there,', 'Hi there, saw powerus.de.'))).toEqual([]);
  });
});

describe('changedLines', () => {
  it('passes an added sentence, even one sharing a line with the sender', () => {
    const written = OFFER.replace(
      'If PowerUs',
      'Saw PowerUs is hiring an Account Executive. If PowerUs',
    );
    expect(changedLines(OFFER, written)).toEqual([]);
  });

  it("lists a line of the sender's the AI reworded", () => {
    const written = OFFER.replace('keeps those mailboxes out of spam', 'keeps you out of spam');
    expect(changedLines(OFFER, written)).toEqual([
      'If PowerUs sends its own cold email, WarmHawk keeps those mailboxes out of spam.',
    ]);
  });
});

describe('restoreParagraphBreaks', () => {
  it('puts the blank line back after the greeting and before the next paragraph', () => {
    const email = 'Hi there,\n\nI saw you maintain automations.\n\nSanthi T.';
    const written =
      'Hi there,\nThe Catalysis Group sells automation as a service.\nI saw you maintain automations.\n\nSanthi T.';
    expect(restoreParagraphBreaks(email, written)).toBe(
      'Hi there,\n\nThe Catalysis Group sells automation as a service.\n\nI saw you maintain automations.\n\nSanthi T.',
    );
  });

  it('leaves a sign-off block together and an already-spaced email alone', () => {
    expect(restoreParagraphBreaks(OFFER, OFFER)).toBe(OFFER);
  });
});

describe('isFreeMailCompany', () => {
  it('knows an email provider from a company', () => {
    expect(isFreeMailCompany('Gmail')).toBe(true);
    expect(isFreeMailCompany(' outlook.com ')).toBe(true);
    expect(isFreeMailCompany('PowerUs')).toBe(false);
    expect(isFreeMailCompany(null)).toBe(false);
  });
});

describe('buildPersonalizationPrompt, lead data and retries', () => {
  it('keeps a free-mail company out of the lead context the model sees', () => {
    const prompt = aiProviderClient.buildPersonalizationPrompt({
      mode: 'PROMPT',
      promptTemplate: '',
      baseEmail: SIGNUP,
      leadContext: { email: 'raol@gmail.com', company: 'Gmail', packageName: 'anvil' },
    });
    expect(prompt).toContain('{"email":"raol@gmail.com","packageName":"anvil"}');
  });

  it('tells AI Writes to copy links, prices and the greeting', () => {
    const prompt = aiProviderClient.buildPersonalizationPrompt({
      mode: 'PROMPT',
      promptTemplate: '',
      baseEmail: OFFER,
      leadContext: {},
    });
    expect(prompt).toContain('keep its greeting as written');
    expect(prompt).toContain('copy every link, web address, price, number and product name');
    expect(prompt).toContain('add no product, claim, number, link or meeting time');
  });

  it('names what the last draft left out on a retry', () => {
    const prompt = aiProviderClient.buildPersonalizationPrompt({
      mode: 'PROMPT',
      promptTemplate: '',
      baseEmail: OFFER,
      leadContext: {},
      mustKeep: ['$499.50', '$99.50'],
    });
    expect(prompt).toContain('This time include each one exactly as written:\n- $499.50\n- $99.50');
  });

  it('names the links the last draft added on a retry', () => {
    const prompt = aiProviderClient.buildPersonalizationPrompt({
      mode: 'PROMPT',
      promptTemplate: '',
      baseEmail: OFFER,
      leadContext: {},
      mustDrop: ['https://example.com/guide'],
    });
    expect(prompt).toContain('This time leave them out:\n- https://example.com/guide');
    expect(prompt).not.toContain('include each one exactly');
  });
});

describe('personalizeChecked', () => {
  const request = {
    provider: 'CLAUDE' as const,
    apiKey: 'k',
    model: 'claude-sonnet-5',
    promptTemplate: '',
    leadContext: {},
    mode: 'PROMPT' as const,
    baseEmail: OFFER,
  };
  const check = (text: string) => ({
    missing: missingFacts(OFFER, text),
    added: addedLinks(OFFER, text),
  });
  const withPrice = 'Hi there,\n\n$499.50 setup, $99.50 a month, see warmhawk.com.';
  const noPrice = 'Hi there,\n\nSee warmhawk.com.';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a first draft that passes, with one call', async () => {
    vi.mocked(aiProviderClient.personalizeContent).mockResolvedValueOnce({
      generatedText: withPrice,
    });
    const result = await personalizeChecked(request, check);
    expect(result.generatedText).toBe(withPrice);
    expect(aiProviderClient.personalizeContent).toHaveBeenCalledTimes(1);
  });

  it('retries once naming the missing parts, and keeps a retry that passes', async () => {
    vi.mocked(aiProviderClient.personalizeContent)
      .mockResolvedValueOnce({ generatedText: noPrice })
      .mockResolvedValueOnce({ generatedText: withPrice });
    const result = await personalizeChecked(request, check);
    expect(result).toMatchObject({ generatedText: withPrice, aiUsed: true });
    expect(vi.mocked(aiProviderClient.personalizeContent).mock.calls[1][0].mustKeep).toEqual([
      '$499.50',
      '$99.50',
    ]);
  });

  it('retries an email that added a link, naming the link', async () => {
    const withLink = `${withPrice} Guide: https://example.com/guide`;
    vi.mocked(aiProviderClient.personalizeContent)
      .mockResolvedValueOnce({ generatedText: withLink })
      .mockResolvedValueOnce({ generatedText: withPrice });
    const result = await personalizeChecked(request, check);
    expect(result).toMatchObject({ generatedText: withPrice, aiUsed: true });
    expect(vi.mocked(aiProviderClient.personalizeContent).mock.calls[1][0]).toMatchObject({
      mustKeep: [],
      mustDrop: ['https://example.com/guide'],
    });
  });

  it("sends the sender's own email after a second miss, reason content_dropped", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(aiProviderClient.personalizeContent).mockResolvedValue({ generatedText: noPrice });
    const result = await personalizeChecked(request, check);
    expect(result).toEqual({
      generatedText: '',
      aiUsed: false,
      aiPersonalizationFailed: true,
      aiFallbackReason: 'content_dropped',
    });
    expect(aiProviderClient.personalizeContent).toHaveBeenCalledTimes(2);
  });
});
