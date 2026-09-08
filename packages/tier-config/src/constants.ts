/**
 * WarmHawk — Single Source of Truth for tier/feature constants (V12 spec, "Single Source of
 * Truth — Tier & Feature Constants").
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------------------------
 * The Monetization Feature Matrix in the WarmHawk V12 spec is otherwise just a markdown table
 * with nothing in the codebase enforcing it — a common, easy-to-miss risk: docs and shipped
 * pricing quietly drifting apart for months, unnoticed. Every tier-gated behavior in either
 * WarmHawk repo MUST read from this file. No route, no UI component, no `LicenseGate` check may
 * hardcode a tier name or a feature flag independently of this file.
 *
 * CROSS-REPO CONTRACT — READ THIS BEFORE EDITING
 * ---------------------------------------------------------------------------------------------
 * This file lives in `warmhawk-core-engine` (packages/tier-config) and is imported directly by
 * that repo's own API/worker code. The licensed dashboard is a SEPARATE repo/package
 * boundary (own Postgres, own containers, own nginx — the two packages never share a Docker
 * network, a Postgres instance, or an nginx container, per the Containerization Model) and
 * therefore CANNOT `import` this file directly across a repo boundary at build time. Instead,
 * the licensed dashboard ships its OWN copy of this exact file (same relative path
 * suggested: `packages/tier-config/src/constants.ts`), which MUST match this file's exported
 * shape byte-for-byte in terms of:
 *
 *   1. The `Tier` string-literal union type (exactly `'tier_0' | 'tier_1' | 'tier_2'`).
 *   2. The `TierFeatures` interface (field names, types, optionality — see below).
 *   3. The `TIER_FEATURES: Record<Tier, TierFeatures>` object's keys and value shapes.
 *   4. The `SupportSlaMetadata` interface and `SUPPORT_SLA` map.
 *   5. The exported helper functions' names and signatures (`getTierFeatures`, `isFeatureEnabled`,
 *      `hasTeamManagement`, `hasTwoFactorRequirement`).
 *
 * If the two files ever diverge, the licensed dashboard's `LicenseGate` and dashboard UI
 * will enforce a DIFFERENT feature matrix than the one `warmhawk-core-engine`/marketing renders
 * from — the exact drift this file exists to prevent. Until a private npm registry or git
 * submodule-free shared-package mechanism is set up between the two repos, keeping them in sync
 * is a manual, reviewed step on every edit to this file — note it in `CHANGELOG.md` when it
 * happens so the sibling repo's maintainer (or agent) knows to re-sync.
 *
 * WarmHawk's billing/marketing site cannot import a TypeScript file into static
 * marketing pages either — its pricing table stays hand-synced against this file, re-checked
 * against it before every release, never assumed current.
 */

/** The three commercial tiers, in ascending order. String literals, never renamed casually —
 *  any rename is a breaking change across both repos and the marketing site. */
export type Tier = 'tier_0' | 'tier_1' | 'tier_2';

export const TIERS: readonly Tier[] = ['tier_0', 'tier_1', 'tier_2'] as const;

/** Human-readable display names, kept here so both repos and any dynamic marketing surface
 *  render the identical label. */
export const TIER_DISPLAY_NAME: Record<Tier, string> = {
  tier_0: 'Open Core',
  tier_1: 'Self-Hosted Pro',
  tier_2: 'Enterprise DFY',
};

export interface SupportSlaMetadata {
  /** Support channel description shown in-product and on the pricing page. */
  channel: string;
  /** Human-readable first-response commitment. `null` means best-effort, no SLA. */
  firstResponse: string | null;
  /** Human-readable critical-issue response commitment. `null` means no elevated tier exists. */
  criticalResponse: string | null;
  /** Who staffs this tier's support at launch — always the founder today, kept explicit so the
   *  SLA is provably "staffed," not just promised (per Support Model & SLA). */
  staffedBy: string;
}

export interface TierFeatures {
  /** Tier 1/2 only — Tier 0 is "direct API endpoints, no web UI." */
  dashboardAccess: boolean;
  /** Unlimited client domains, mailboxes & users under one flat fee — N/A (false) for Tier 0,
   *  which has no seat/account concept at all. */
  unlimitedSeats: boolean;
  /** Live queue inspector, throttling controls, analytics, domain health alerts. */
  liveQueueInspector: boolean;
  /** Bundled Uptime Kuma container, on by default, 1-min checks against every service. */
  uptimeKumaBundled: boolean;
  /** Native OTEL export env vars wired into api/worker (inert until customer sets an endpoint). */
  otelExportEnabled: boolean;
  /** Nightly Postgres backup script + install.sh cron wiring, default-on. */
  nightlyBackupsDefaultOn: boolean;
  /** TOTP 2FA/MFA required (or at minimum strongly prompted) at first dashboard login. */
  twoFactorRequired: boolean;
  /** Team invite/remove (flat permissions, no roles) — the V12 Team & User Management feature. */
  teamManagement: boolean;
  /** Who-did-what-when audit log — Tier 2 only, growth-stage/procurement-gated per the backlog. */
  auditLog: boolean;
  /** Guided first-login onboarding checklist (connect mailbox -> import leads -> AI provider ->
   *  launch campaign). N/A for Tier 0, which has no dashboard to onboard into. */
  onboardingChecklist: boolean;
  /** True only for Tier 2 — the generic client-side "is this a Tier 2 install" switch used to
   *  gate the trust badge, certificate/compliance-report downloads, and the lookalike panel.
   *  Renamed from `managedDeployment`: that name implied WarmHawk operates the customer's
   *  deployment/DNS/IPs, which was never true (installs are single-tenant, customer-hosted). */
  isTier2: boolean;
  /** 30-day money-back guarantee applies to this tier's billing. */
  moneyBackGuarantee: boolean;
  /** Support SLA metadata for this tier — see `SupportSlaMetadata` above. */
  supportSla: SupportSlaMetadata;
}

export const TIER_FEATURES: Record<Tier, TierFeatures> = {
  tier_0: {
    dashboardAccess: false,
    unlimitedSeats: false,
    liveQueueInspector: false,
    uptimeKumaBundled: false,
    otelExportEnabled: false,
    nightlyBackupsDefaultOn: false,
    twoFactorRequired: false,
    teamManagement: false,
    auditLog: false,
    onboardingChecklist: false,
    isTier2: false,
    moneyBackGuarantee: false,
    supportSla: {
      channel: 'Community (GitHub Issues + Discussions)',
      firstResponse: null,
      criticalResponse: null,
      staffedBy: 'Founder, ad hoc',
    },
  },
  tier_1: {
    dashboardAccess: true,
    unlimitedSeats: true,
    liveQueueInspector: true,
    uptimeKumaBundled: true,
    otelExportEnabled: true,
    nightlyBackupsDefaultOn: true,
    twoFactorRequired: true,
    teamManagement: true,
    auditLog: false,
    onboardingChecklist: true,
    isTier2: false,
    moneyBackGuarantee: true,
    supportSla: {
      channel: 'support@warmhawk.com (shared inbox)',
      firstResponse: '1 business day',
      criticalResponse: '4 business hours',
      staffedBy: 'Founder, directly',
    },
  },
  tier_2: {
    dashboardAccess: true,
    unlimitedSeats: true,
    liveQueueInspector: true,
    uptimeKumaBundled: true,
    otelExportEnabled: true,
    nightlyBackupsDefaultOn: true,
    twoFactorRequired: true,
    teamManagement: true,
    auditLog: false, // flips true once built — see Post-Launch Backlog "Audit logs"
    onboardingChecklist: true,
    isTier2: true,
    moneyBackGuarantee: false, // custom-scoped engagement, not a self-serve subscription
    supportSla: {
      channel: 'Direct founder email thread / Slack Connect',
      firstResponse: 'Same business day',
      criticalResponse: 'Same business day',
      staffedBy: 'Founder, directly',
    },
  },
};

/** Convenience accessor — always read tier features through this function, never index
 *  `TIER_FEATURES` directly from application code, so a future lookup-miss guard has one place
 *  to live. */
export function getTierFeatures(tier: Tier): TierFeatures {
  const features = TIER_FEATURES[tier];
  if (!features) {
    throw new Error(`Unknown WarmHawk tier: ${tier}`);
  }
  return features;
}

/** Generic boolean feature check, for callsites that just need a yes/no
 *  (e.g. `isFeatureEnabled('tier_1', 'teamManagement')`). */
export function isFeatureEnabled(
  tier: Tier,
  feature: keyof Omit<TierFeatures, 'supportSla'>,
): boolean {
  return Boolean(getTierFeatures(tier)[feature]);
}

/** Named convenience wrapper — `LicenseGate` and the dashboard Team Members page both gate on
 *  this exact check, so there is exactly one code path answering "does this tier get team
 *  management." */
export function hasTeamManagement(tier: Tier): boolean {
  return getTierFeatures(tier).teamManagement;
}

/** Named convenience wrapper for the 2FA enrollment gate. */
export function hasTwoFactorRequirement(tier: Tier): boolean {
  return getTierFeatures(tier).twoFactorRequired;
}

export const SUPPORT_SLA: Record<Tier, SupportSlaMetadata> = {
  tier_0: TIER_FEATURES.tier_0.supportSla,
  tier_1: TIER_FEATURES.tier_1.supportSla,
  tier_2: TIER_FEATURES.tier_2.supportSla,
};
