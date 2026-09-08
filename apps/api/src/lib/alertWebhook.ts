/**
 * Tier-2-only alert webhook — posts a single domain DNS-check field change (SPF/DKIM/DMARC/
 * blocklist status flip) to a founder-configured Slack or generic webhook URL. This is a new,
 * small, self-contained feature: there is no existing digest/notification system in this repo to
 * extend (that belongs to the sibling `warmhawk-probe` repo and is irrelevant here).
 *
 * `TIER2_ALERT_WEBHOOK_URL` unset is itself the gate — every non-Tier-2 install leaves it blank
 * and this function becomes a silent no-op, exactly like `UPTIME_KUMA_ALERT_WEBHOOK_URL`'s own
 * "leave blank for no external alerting" convention (.env/.env.example). There is deliberately no
 * separate tier-branching check anywhere in this repo: Tier 2 is a manual, white-glove install
 * step the founder sets up per customer, not a runtime concept this engine tracks.
 *
 * `fetchImpl`: this repo's one existing precedent for a real outbound `fetch` call
 * (`aiProviders/claude.ts` / `aiProviders/gemini.ts`) calls the global `fetch` directly and has
 * its tests mock `global.fetch` — there's no existing dependency-injection-for-`fetch` pattern to
 * follow here. Per instruction, falling back to the simple optional-second-parameter form.
 */
export interface DomainFieldChange {
  domain: string;
  field: string;
  before: string;
  after: string;
}

export async function postDomainChangeAlert(
  change: DomainFieldChange,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = process.env.TIER2_ALERT_WEBHOOK_URL;
  if (!url) return; // inert on any install that hasn't set this — the real "gate"

  const format = process.env.TIER2_ALERT_WEBHOOK_FORMAT ?? 'generic';
  const body =
    format === 'slack'
      ? { text: `⚠️ ${change.domain}: ${change.field} changed from ${change.before} to ${change.after}` }
      : { domain: change.domain, field: change.field, before: change.before, after: change.after };

  await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
