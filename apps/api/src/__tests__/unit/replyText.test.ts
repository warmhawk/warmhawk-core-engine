import { describe, it, expect } from 'vitest';
import { stripQuotedReply } from '../../lib/replyText';
import { classifyByKeyword } from '../../lib/aiProviderClient';

const FOOTER = [
  '--',
  '204 Example St',
  'Austin, TX 78701',
  'Unsubscribe: https://wh.example.com/unsubscribe/tok',
];

describe('stripQuotedReply', () => {
  it('cuts a Gmail quote, including the wrapped "On … wrote:" header', () => {
    const text = [
      'Sounds good, Thursday works.',
      '',
      'On Mon, Oct 5, 2026 at 3:00 PM Santhi T. <',
      'sender@example.com> wrote:',
      '',
      ...FOOTER.map((l) => `> ${l}`),
    ].join('\n');
    expect(stripQuotedReply(text)).toBe('Sounds good, Thursday works.');
  });

  it('cuts an Apple Mail quote', () => {
    const text = [
      'No thanks.',
      '',
      'On Oct 5, 2026, at 3:00 PM, Santhi T. <s@example.com> wrote:',
      '',
      '> Hi',
    ].join('\n');
    expect(stripQuotedReply(text)).toBe('No thanks.');
  });

  it('cuts an Outlook quote under a separator line, which has no ">" prefixes', () => {
    const text = [
      'Please take me off your list.',
      '',
      '________________________________',
      'From: Santhi T. <s@example.com>',
      'Sent: Monday, October 5, 2026 3:00 PM',
      'Subject: Quick question',
      '',
      'Hi Ana,',
      ...FOOTER,
    ].join('\r\n');
    expect(stripQuotedReply(text)).toBe('Please take me off your list.');
  });

  it('cuts an Outlook "From: / Sent:" block with no separator', () => {
    const text = [
      'Interested.',
      'From: Santhi T. <s@example.com>',
      'Sent: Monday',
      'Hi',
      ...FOOTER,
    ].join('\n');
    expect(stripQuotedReply(text)).toBe('Interested.');
  });

  it('cuts "-----Original Message-----"', () => {
    const text = [
      'Remove me',
      '-----Original Message-----',
      'Unsubscribe: https://x.example/u',
    ].join('\n');
    expect(stripQuotedReply(text)).toBe('Remove me');
  });

  it('keeps the words of an inline reply written between quoted lines', () => {
    const text = [
      'On Mon, Oct 5, 2026 at 3:00 PM Santhi T. <s@example.com> wrote:',
      '> Would a 10-minute call help?',
      'Yes, sounds good.',
      ...FOOTER.map((l) => `> ${l}`),
    ].join('\n');
    expect(stripQuotedReply(text)).toBe('Yes, sounds good.');
  });

  it('returns a reply that quotes nothing unchanged', () => {
    expect(stripQuotedReply('Please stop emailing me.')).toBe('Please stop emailing me.');
  });

  it('keeps the person\'s own "unsubscribe" wording', () => {
    expect(stripQuotedReply('Unsubscribe me please.\n\nOn Mon wrote:\n> hi')).toBe(
      'Unsubscribe me please.',
    );
  });
});

describe('classifyByKeyword on stripped replies', () => {
  it.each([
    ['Please stop emailing me.', 'OPT_OUT'],
    ['Take me off your list', 'OPT_OUT'],
    ["Don't email me again", 'OPT_OUT'],
    ['Do not contact me', 'OPT_OUT'],
    ['Not interested, thanks.', 'NOT_INTERESTED'],
    ["I'm uninterested", 'NOT_INTERESTED'],
    ["Sounds good, let's talk", 'INTERESTED'],
    ["Don't stop sending these, they're great", 'UNCLASSIFIED'],
  ] as const)('%s → %s', (reply, label) => {
    expect(classifyByKeyword(stripQuotedReply(reply))).toBe(label);
  });
});
