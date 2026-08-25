# Microsoft 365 OAuth — Setup Note

> **Status: code complete, external dependency pending.** `lib/microsoftOAuth.ts` and the
> `oauthCallback.ts` wiring are fully built and unit-tested (HTTP boundary mocked). What's
> blocked is entirely outside this codebase: a real **Microsoft Entra app registration**.

## What's required (external, not something this repo can do on its own)

1. Register an app in the [Microsoft Entra admin center](https://entra.microsoft.com) under the
   tenant that will own the OAuth consent screen (WarmHawk's own tenant for a WarmHawk-branded
   "Connect with Microsoft" button).
2. Request delegated scopes: `Mail.Send`, `IMAP.AccessAsUser.All`, `offline_access`.
3. Depending on the scopes' sensitivity tier and target audience (single-tenant vs.
   multi-tenant "any Microsoft 365 organization"), Microsoft's verification/consent process can
   take **weeks** — the same order of magnitude as Google's CASA assessment for the
   `https://mail.google.com/` scope.
4. Once registered, set `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, and
   `MICROSOFT_OAUTH_REDIRECT_URI` in `.env`.

## Why this isn't a launch blocker

Per the spec: SMTP/IMAP username+password remains the universal fallback for any mailbox
provider without a working OAuth flow yet. Microsoft 365 OAuth ships as a fast-follow once
verification clears, tracked separately from the Go-Live Checklist.

## Google Workspace — a re-verification note, not a fresh registration

Google Workspace OAuth is ported forward from outreach-infra's already-working implementation,
but the OAuth consent screen itself was verified under outreach-infra's own app identity. A
WarmHawk-branded rebrand typically requires a **new** app registration/consent screen (new
client ID, new verification pass) — confirm whether Google's existing verification for the old
app can be transferred, or whether a fresh CASA assessment is required, before assuming Google
Workspace connect "just works" under the WarmHawk brand on day one.
