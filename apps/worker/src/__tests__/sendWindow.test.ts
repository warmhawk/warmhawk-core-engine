import { describe, it, expect } from 'vitest';
import { leadWindowState, type CampaignSendSettings } from '../sendWindow';

const base: CampaignSendSettings = {
  sendTimezone: 'America/New_York',
  sendDays: [1, 2, 3, 4, 5],
  sendStartMinute: 9 * 60,
  sendEndMinute: 17 * 60,
  useLeadTimezone: false,
};
// Wed 14 Oct 2026 13:30 UTC = 9:30 EDT, 6:30 PDT.
const now = new Date('2026-10-14T13:30:00Z');

describe('leadWindowState', () => {
  it('uses the campaign zone when the campaign does not send in lead zones', () => {
    expect(leadWindowState(base, { State: 'CA' }, now).open).toBe(true);
  });

  it("uses the lead's own zone when asked, and waits for a lead it is still early for", () => {
    const perLead = { ...base, useLeadTimezone: true };
    const state = leadWindowState(perLead, { State: 'CA' }, now);
    expect(state.open).toBe(false);
    expect(state.nextOpenAt?.toISOString()).toBe('2026-10-14T16:00:00.000Z');
  });

  it("falls back to the campaign zone when the lead's zone can't be told", () => {
    const perLead = { ...base, useLeadTimezone: true };
    expect(leadWindowState(perLead, { title: 'Owner' }, now).open).toBe(true);
  });

  it('is always open for a campaign without a schedule', () => {
    const none = { ...base, sendTimezone: null, sendStartMinute: null, sendEndMinute: null };
    expect(leadWindowState(none, null, new Date('2026-10-18T03:00:00Z')).open).toBe(true);
  });
});
