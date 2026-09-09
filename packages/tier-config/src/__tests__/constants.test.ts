import { describe, it, expect } from 'vitest';
import {
  TIERS,
  TIER_FEATURES,
  getTierFeatures,
  isFeatureEnabled,
  hasTeamManagement,
  hasTwoFactorRequirement,
} from '../constants';

describe('tier-config constants', () => {
  it('defines exactly three tiers in ascending order', () => {
    expect(TIERS).toEqual(['tier_0', 'tier_1', 'tier_2']);
  });

  it('tier_0 has no dashboard, no team management, no SLA', () => {
    const f = getTierFeatures('tier_0');
    expect(f.dashboardAccess).toBe(false);
    expect(f.teamManagement).toBe(false);
    expect(f.supportSla.firstResponse).toBeNull();
  });

  it('tier_1 has dashboard, team management, 2FA required, and a 1-business-day SLA', () => {
    const f = getTierFeatures('tier_1');
    expect(f.dashboardAccess).toBe(true);
    expect(f.teamManagement).toBe(true);
    expect(f.twoFactorRequired).toBe(true);
    expect(f.supportSla.firstResponse).toBe('1 business day');
    expect(f.supportSla.criticalResponse).toBe('4 business hours');
  });

  it('tier_2 is flagged isTier2 and gets same-business-day support, no money-back guarantee', () => {
    const f = getTierFeatures('tier_2');
    expect(f.isTier2).toBe(true);
    expect(f.moneyBackGuarantee).toBe(false);
    expect(f.supportSla.firstResponse).toBe('Same business day');
  });

  it('isFeatureEnabled matches the underlying TIER_FEATURES map', () => {
    for (const tier of TIERS) {
      expect(isFeatureEnabled(tier, 'teamManagement')).toBe(TIER_FEATURES[tier].teamManagement);
    }
  });

  it('hasTeamManagement / hasTwoFactorRequirement convenience wrappers agree with the map', () => {
    for (const tier of TIERS) {
      expect(hasTeamManagement(tier)).toBe(TIER_FEATURES[tier].teamManagement);
      expect(hasTwoFactorRequirement(tier)).toBe(TIER_FEATURES[tier].twoFactorRequired);
    }
  });

  it('getTierFeatures throws on an unknown tier', () => {
    // @ts-expect-error intentionally invalid tier for the runtime-guard test
    expect(() => getTierFeatures('tier_99')).toThrow(/Unknown WarmHawk tier/);
  });
});
