/**
 * Send-time compliance enforcement — Guardrails, "enforced structurally, not just documented."
 * Three independent structural gates, each meant to be called from the actual send pipeline
 * (the n8n dispatch workflow's callback into this API, or a future direct-send path) so no
 * campaign can go out missing them:
 *
 *   1. CAN-SPAM auto-injection: refuse to send a campaign missing a physical mailing address
 *      (instance-wide setting) or an unsubscribe mechanism.
 *   2. RFC 8058 one-click unsubscribe headers, generated server-side on every send —
 *      `List-Unsubscribe` + `List-Unsubscribe-Post: One-Click`, not left to template config.
 *   3. EU AI Act Article 50 disclosure marker, auto-appended when the campaign has an AI
 *      provider configured AND the recipient resolves to an EU-region signal.
 */

export class CanSpamComplianceError extends Error {}

export interface CanSpamCheckInput {
  physicalMailingAddress: string | null | undefined;
  unsubscribeUrlTemplate: string | null | undefined;
}

/** Throws `CanSpamComplianceError` if either required CAN-SPAM element is missing. Call this
 *  BEFORE handing a campaign+lead pair to the send pipeline — the check is unconditional and
 *  cannot be bypassed by any caller (API route, CSV import, webhook ingest, dashboard) since it
 *  lives in the one shared send path, not duplicated per entry point. */
export function assertCanSpamCompliant(input: CanSpamCheckInput): void {
  if (!input.physicalMailingAddress || input.physicalMailingAddress.trim().length === 0) {
    throw new CanSpamComplianceError(
      'Cannot send: instance has no configured physical mailing address (CAN-SPAM requires one on every commercial email).',
    );
  }
  if (!input.unsubscribeUrlTemplate || input.unsubscribeUrlTemplate.trim().length === 0) {
    throw new CanSpamComplianceError(
      'Cannot send: campaign has no unsubscribe link configured (CAN-SPAM requires a working opt-out mechanism).',
    );
  }
}

export interface Rfc8058Headers {
  'List-Unsubscribe': string;
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click';
}

/**
 * Builds the RFC 8058 header pair unconditionally attached to every send. `unsubscribeUrl` MUST
 * be an `https:` URL supporting the one-click POST semantics (or a `mailto:` fallback per RFC
 * 8058 section 4.1) — both forms are accepted, `https:` preferred since it's what Gmail/Yahoo's
 * 2024+ bulk-sender rules actually act on.
 */
export function buildRfc8058Headers(unsubscribeUrl: string): Rfc8058Headers {
  if (!/^https?:|^mailto:/i.test(unsubscribeUrl)) {
    throw new CanSpamComplianceError(
      `Invalid unsubscribe URL for List-Unsubscribe header: "${unsubscribeUrl}" (must be https:// or mailto:)`,
    );
  }
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// -------------------------------------------------------------------------------------------
// EU AI Act Article 50 disclosure marker
// -------------------------------------------------------------------------------------------

/** Approximate, DNS-free EU-region signal based on the recipient's email TLD/ccTLD. This is a
 *  heuristic (no GeoIP/IP-geolocation dependency, consistent with WarmHawk never touching
 *  customer lead data beyond what's needed to send) — good enough to err on the side of adding
 *  the disclosure marker rather than omitting it for an ambiguous `.com` address that is
 *  otherwise signaled as EU (e.g. via a customFields country field, checked first if present). */
const EU_CCTLDS = new Set([
  'de',
  'fr',
  'it',
  'es',
  'nl',
  'be',
  'pl',
  'se',
  'at',
  'dk',
  'fi',
  'ie',
  'pt',
  'gr',
  'cz',
  'hu',
  'ro',
  'bg',
  'hr',
  'sk',
  'si',
  'lt',
  'lv',
  'ee',
  'lu',
  'mt',
  'cy',
]);

export interface EuSignalInput {
  email: string;
  /** Optional explicit country/region field from `customFields`, checked before the TLD
   *  heuristic — e.g. `{ country: 'Germany' }` or `{ countryCode: 'DE' }`. */
  countryCode?: string | null;
}

export function isEuRecipient(input: EuSignalInput): boolean {
  if (input.countryCode) {
    return EU_CCTLDS.has(input.countryCode.trim().toLowerCase());
  }
  const domain = input.email.split('@')[1]?.toLowerCase() ?? '';
  const tld = domain.split('.').pop() ?? '';
  return EU_CCTLDS.has(tld);
}

const EU_AI_DISCLOSURE_MARKER =
  '\n\n---\nThis message was generated with the assistance of AI, in accordance with EU AI Act Article 50.';

/** Appends the disclosure marker to `body` when `aiProviderConfigured` is true AND the recipient
 *  resolves to an EU-region signal — invisible to the sender's workflow otherwise, enforced by
 *  the pipeline itself (Guardrails), not left to the customer to remember. Idempotent: does not
 *  double-append if the marker is already present. */
export function appendEuAiDisclosureIfNeeded(
  body: string,
  aiProviderConfigured: boolean,
  recipient: EuSignalInput,
): { body: string; disclosureAppended: boolean } {
  if (!aiProviderConfigured || !isEuRecipient(recipient)) {
    return { body, disclosureAppended: false };
  }
  if (body.includes('EU AI Act Article 50')) {
    return { body, disclosureAppended: false };
  }
  return { body: body + EU_AI_DISCLOSURE_MARKER, disclosureAppended: true };
}
