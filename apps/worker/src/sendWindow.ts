/**
 * Which send window applies to one lead (10-14-26): the campaign's own, or — when the campaign
 * sends "in each lead's time zone" — the same days and hours read in the lead's zone, told from
 * its CSV columns. A lead whose zone can't be told uses the campaign's.
 */
import {
  campaignSchedule,
  detectLeadTimezone,
  windowState,
  type CampaignScheduleFields,
  type WindowState,
} from '@warmhawk/db';

export interface CampaignSendSettings extends CampaignScheduleFields {
  useLeadTimezone: boolean;
}

/** The select that loads `CampaignSendSettings`. */
export const SEND_SETTINGS_SELECT = {
  sendTimezone: true,
  sendDays: true,
  sendStartMinute: true,
  sendEndMinute: true,
  useLeadTimezone: true,
} as const;

export function leadWindowState(
  campaign: CampaignSendSettings,
  customFields: unknown,
  now: Date,
): WindowState {
  const schedule = campaignSchedule(campaign);
  if (!schedule || !campaign.useLeadTimezone) return windowState(schedule, now);
  return windowState(schedule, now, detectLeadTimezone(customFields) ?? schedule.timezone);
}
