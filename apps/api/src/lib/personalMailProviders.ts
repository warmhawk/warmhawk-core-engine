/**
 * Free mailbox providers — the domains of a personal Gmail, Yahoo or Outlook.com address.
 *
 * A buyer trying WarmHawk often connects one of these first, so they get a Domain row like any
 * other (it holds the CAN-SPAM mailing address). But SPF, DKIM, DMARC and blocklist standing for
 * `gmail.com` belong to Google, not the buyer: checking them is noise, and a lookalike scan of
 * `gmail.com` is a flood of false alerts. Callers use `isPersonalMailProvider` to skip those.
 *
 * A code list, not a column, so a provider domain added before this existed is covered too.
 */
const PERSONAL_MAIL_PROVIDERS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'rocketmail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'gmx.com',
  'mail.com',
  'yandex.com',
]);

/** The provider's display name for the Domains page note, e.g. "Google". */
const PROVIDER_NAMES: Record<string, string> = {
  'gmail.com': 'Google',
  'googlemail.com': 'Google',
  'outlook.com': 'Microsoft',
  'hotmail.com': 'Microsoft',
  'live.com': 'Microsoft',
  'msn.com': 'Microsoft',
  'yahoo.com': 'Yahoo',
  'ymail.com': 'Yahoo',
  'rocketmail.com': 'Yahoo',
  'icloud.com': 'Apple',
  'me.com': 'Apple',
  'mac.com': 'Apple',
};

export function isPersonalMailProvider(domainName: string): boolean {
  return PERSONAL_MAIL_PROVIDERS.has(domainName.trim().toLowerCase());
}

/** Who runs this provider's DNS, for messages — "Google", or the domain itself when unnamed. */
export function personalMailProviderName(domainName: string): string {
  const name = domainName.trim().toLowerCase();
  return PROVIDER_NAMES[name] ?? name;
}

/** Every listed provider domain, for a `notIn` filter. */
export function personalMailProviderDomains(): string[] {
  return [...PERSONAL_MAIL_PROVIDERS];
}
