/**
 * Expected campaign sends per day ahead (10-14-26), for the Live Queue's future days. The worker
 * books one slot per mailbox at a time (`apps/worker/src/enqueuer.ts`), so the dispatch queue
 * never holds tomorrow's emails — counting jobs left every future day at 0. This plays the
 * enqueuer's rules forward a day at a time instead:
 *
 *   - Each mailbox sends up to that day's campaign cap (the post-graduation ramp included).
 *   - A campaign sends only on its ticked days, read in its own time zone.
 *   - Due follow-ups go first, from the lead's own mailbox; a sent follow-up books the next one
 *     after its step's wait.
 *   - First emails go next, spread over the campaign's mailboxes, up to its max new leads per day;
 *     each starts the lead's follow-ups.
 *
 * Today (10-15-26) is played first when the caller passes what each mailbox already used today:
 * its cap less the emails sent or booked, only for campaigns whose window hasn't closed yet. Before
 * this, the Today bar read 0 every morning until the window opened.
 *
 * An estimate, not a promise: replies, bounces and unsubscribes end sequences early, a lead's own
 * time zone can move its day, and cap or campaign edits change the plan. It's an upper bound in
 * the usual case.
 */
import { campaignSchedule, localParts, prisma, type SendSchedule } from '@warmhawk/db';
import { campaignCapToday } from './warmup/policy';

const DAY_MS = 24 * 60 * 60 * 1000;
// Recomputed at most this often — the Live Queue polls every 5 seconds.
const CACHE_MS = 60 * 1000;

export interface ForecastMailbox {
  id: string;
  dailyCap: number;
  warmupGraduatedAt: Date | null;
}

export interface ForecastCampaign {
  id: string;
  maxNewLeadsPerDay: number | null;
  schedule: SendSchedule | null;
  /** The campaign's sending mailboxes. */
  mailboxIds: string[];
  /** Follow-up wait in days by step position (1 = the first follow-up). */
  waitDays: Record<number, number>;
  /** Leads still waiting on their first email and not booked yet. */
  firstEmailsLeft: number;
}

export interface ForecastFollowUp {
  campaignId: string;
  mailboxId: string;
  /** Emails already sent, so the follow-up due is step `stepsSent`. */
  stepsSent: number;
  dueAtMs: number;
}

export interface SendForecast {
  /** Today's UTC day first when `usedToday` was passed (what's still to come today), then the
   *  `days` UTC days after today, soonest first, every day present even at 0. */
  byDay: { day: string; count: number }[];
  /** Expected sends per mailbox, by UTC day; days with none are left out. */
  byMailbox: Map<string, Map<string, number>>;
  /** UTC days, from `pastDays` back through the last forecast day, on which no active campaign
   *  sends (a weekend for a Mon–Fri schedule). Empty when no campaign is active. */
  offDays: string[];
}

/** Whether a campaign sends on the UTC day starting at `dayStartMs`, read at midday in its zone. */
function sendsOn(schedule: SendSchedule | null, dayStartMs: number): boolean {
  if (!schedule) return true;
  const { weekday } = localParts(schedule.timezone, new Date(dayStartMs + DAY_MS / 2));
  return schedule.days.includes(weekday);
}

/** Whether a campaign can still send today: a ticked day whose window hasn't closed yet. */
function sendsLaterToday(schedule: SendSchedule | null, now: Date): boolean {
  if (!schedule) return true;
  const { weekday, minute } = localParts(schedule.timezone, now);
  return schedule.days.includes(weekday) && minute < schedule.endMinute;
}

/** The `count` UTC days from `firstDayMs` on which none of `campaigns` sends, read the way the
 *  forecast reads them. None when there are no campaigns: nothing is "off", there's just nothing. */
export function offDays(
  campaigns: Pick<ForecastCampaign, 'schedule'>[],
  firstDayMs: number,
  count: number,
): string[] {
  if (campaigns.length === 0) return [];
  return Array.from({ length: count }, (_, i) => firstDayMs + i * DAY_MS)
    .filter((dayStart) => !campaigns.some((c) => sendsOn(c.schedule, dayStart)))
    .map((dayStart) => new Date(dayStart).toISOString().slice(0, 10));
}

/**
 * Plays the enqueuer's rules forward over the `days` UTC days after `now`'s. With `usedToday`
 * (campaign emails each mailbox has sent or booked today), the rest of today goes first. Pure; no
 * I/O.
 */
export function forecastSends(
  now: Date,
  days: number,
  mailboxes: ForecastMailbox[],
  campaigns: ForecastCampaign[],
  followUps: ForecastFollowUp[],
  usedToday?: Map<string, number>,
): SendForecast {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const mailboxById = new Map(mailboxes.map((m) => [m.id, m]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const firstEmailsLeft = new Map(campaigns.map((c) => [c.id, c.firstEmailsLeft]));
  let pending = followUps.filter(
    (f) => campaignById.has(f.campaignId) && mailboxById.has(f.mailboxId),
  );
  const byDay: SendForecast['byDay'] = [];
  const byMailbox: SendForecast['byMailbox'] = new Map();

  for (let offset = usedToday ? 0 : 1; offset <= days; offset += 1) {
    const dayStart = today + offset * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const sentAt = Math.max(now.getTime(), dayStart + DAY_MS / 2);
    const day = new Date(dayStart).toISOString().slice(0, 10);
    // The same cap the per-mailbox table shows for this day.
    const capLeft = new Map(
      mailboxes.map((m) => [
        m.id,
        campaignCapToday(
          m.dailyCap,
          m.warmupGraduatedAt,
          new Date(now.getTime() + offset * DAY_MS),
        ) - (offset === 0 ? (usedToday?.get(m.id) ?? 0) : 0),
      ]),
    );
    const open = new Set(
      campaigns
        .filter((c) =>
          offset === 0 ? sendsLaterToday(c.schedule, now) : sendsOn(c.schedule, dayStart),
        )
        .map((c) => c.id),
    );
    let count = 0;
    const send = (mailboxId: string, campaign: ForecastCampaign, stepsSent: number) => {
      capLeft.set(mailboxId, (capLeft.get(mailboxId) ?? 0) - 1);
      count += 1;
      const perDay = byMailbox.get(mailboxId) ?? new Map<string, number>();
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      byMailbox.set(mailboxId, perDay);
      const wait = campaign.waitDays[stepsSent];
      if (wait !== undefined) {
        next.push({
          campaignId: campaign.id,
          mailboxId,
          stepsSent,
          dueAtMs: sentAt + wait * DAY_MS,
        });
      }
    };

    // Due follow-ups first, soonest first, each from its own mailbox.
    const next: ForecastFollowUp[] = [];
    pending.sort((a, b) => a.dueAtMs - b.dueAtMs);
    for (const followUp of pending) {
      const fits =
        followUp.dueAtMs < dayEnd &&
        open.has(followUp.campaignId) &&
        (capLeft.get(followUp.mailboxId) ?? 0) > 0;
      if (fits)
        send(followUp.mailboxId, campaignById.get(followUp.campaignId)!, followUp.stepsSent + 1);
      else next.push(followUp);
    }

    // Then first emails, a lead per campaign in turn, each to its mailbox with the most room.
    const newLeft = new Map(
      campaigns
        .filter((c) => open.has(c.id))
        .map((c) => [
          c.id,
          Math.min(firstEmailsLeft.get(c.id) ?? 0, c.maxNewLeadsPerDay ?? Infinity),
        ]),
    );
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [campaignId, left] of newLeft) {
        if (left <= 0) continue;
        const campaign = campaignById.get(campaignId)!;
        const target = campaign.mailboxIds
          .filter((id) => (capLeft.get(id) ?? 0) > 0)
          .sort((a, b) => (capLeft.get(b) ?? 0) - (capLeft.get(a) ?? 0))[0];
        if (!target) {
          newLeft.set(campaignId, 0);
          continue;
        }
        send(target, campaign, 1);
        newLeft.set(campaignId, left - 1);
        firstEmailsLeft.set(campaignId, (firstEmailsLeft.get(campaignId) ?? 0) - 1);
        progressed = true;
      }
    }

    pending = next;
    byDay.push({ day, count });
  }
  return {
    byDay,
    byMailbox,
    offDays: offDays(campaigns, today + (usedToday ? 0 : DAY_MS), byDay.length),
  };
}

/** The forecast's inputs from the database: sendable mailboxes, active campaigns' work left and
 *  each mailbox's campaign sends so far today (UTC day, the statuses the Live Queue counts). */
async function loadForecastInput(now: Date): Promise<{
  mailboxes: ForecastMailbox[];
  campaigns: ForecastCampaign[];
  followUps: ForecastFollowUp[];
  sentToday: Map<string, number>;
}> {
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [mailboxRows, campaignRows, sentRows] = await Promise.all([
    // The same mailboxes the enqueuer sends from: ACTIVE, with a mailing address for the footer.
    prisma.mailbox.findMany({
      where: { status: 'ACTIVE', domain: { mailingAddress: { not: null } } },
      select: {
        id: true,
        dailyCap: true,
        warmupGraduatedAt: true,
        domain: { select: { mailingAddress: true } },
      },
    }),
    prisma.campaign.findMany({
      where: { status: 'ACTIVE', pausedForBounceRate: false },
      select: {
        id: true,
        maxNewLeadsPerDay: true,
        sendTimezone: true,
        sendDays: true,
        sendStartMinute: true,
        sendEndMinute: true,
        mailboxes: { select: { mailboxId: true } },
        steps: { select: { position: true, waitDays: true } },
      },
    }),
    prisma.executionLog.groupBy({
      by: ['mailboxId'],
      where: {
        status: { in: ['SENT', 'OPENED', 'REPLIED', 'BOUNCED'] },
        mailboxId: { not: null },
        createdAt: { gte: todayStart },
      },
      _count: { _all: true },
    }),
  ]);
  const mailboxes = mailboxRows.filter((m) => m.domain.mailingAddress?.trim());
  const sentToday = new Map(
    sentRows.map((row) => [row.mailboxId as string, row._count._all] as const),
  );
  const campaignIds = campaignRows.map((c) => c.id);
  if (campaignIds.length === 0) return { mailboxes, campaigns: [], followUps: [], sentToday };

  const [firstRows, followUpRows] = await Promise.all([
    // Booked leads (a `queuedJobId`) go out today, so they aren't left for later days.
    prisma.lead.groupBy({
      by: ['campaignId'],
      where: {
        campaignId: { in: campaignIds },
        status: { in: ['UNTOUCHED', 'QUEUED'] },
        queuedJobId: null,
      },
      _count: { _all: true },
    }),
    prisma.lead.findMany({
      where: {
        campaignId: { in: campaignIds },
        status: { in: ['CONTACTED', 'OPENED'] },
        nextStepAt: { not: null },
        queuedJobId: null,
        mailboxId: { not: null },
        replies: { none: {} },
      },
      select: { campaignId: true, mailboxId: true, stepsSent: true, nextStepAt: true },
    }),
  ]);
  const firstLeft = new Map(firstRows.map((row) => [row.campaignId, row._count._all]));
  return {
    mailboxes,
    sentToday,
    campaigns: campaignRows.map((c) => ({
      id: c.id,
      maxNewLeadsPerDay: c.maxNewLeadsPerDay,
      schedule: campaignSchedule(c),
      mailboxIds: c.mailboxes.map((link) => link.mailboxId),
      waitDays: Object.fromEntries(c.steps.map((s) => [s.position, s.waitDays])),
      firstEmailsLeft: firstLeft.get(c.id) ?? 0,
    })),
    followUps: followUpRows.map((lead) => ({
      campaignId: lead.campaignId,
      mailboxId: lead.mailboxId as string,
      stepsSent: lead.stepsSent,
      dueAtMs: (lead.nextStepAt as Date).getTime(),
    })),
  };
}

let cached: {
  at: number;
  days: number;
  pastDays: number;
  key: string;
  forecast: SendForecast;
} | null = null;

/**
 * The rest of today, then the `days` UTC days after it, recomputed at most once a minute or when
 * the booked slots change. `bookedByMailbox` is each mailbox's dispatch jobs in the queue: they
 * leave today and use its cap, and their leads are already out of the forecast's lead counts.
 * `offDays` also covers the `pastDays` before today, by today's campaigns.
 */
export async function sendForecast(
  now: Date,
  days: number,
  bookedByMailbox: Map<string, number> = new Map(),
  pastDays = 0,
): Promise<SendForecast> {
  const key = [...bookedByMailbox].sort().join(',');
  if (
    cached &&
    cached.days === days &&
    cached.pastDays === pastDays &&
    cached.key === key &&
    now.getTime() - cached.at < CACHE_MS
  ) {
    const sameDay =
      new Date(cached.at).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
    if (sameDay) return cached.forecast;
  }
  const input = await loadForecastInput(now);
  const usedToday = new Map(input.sentToday);
  for (const [id, n] of bookedByMailbox) usedToday.set(id, (usedToday.get(id) ?? 0) + n);
  const forecast = forecastSends(
    now,
    days,
    input.mailboxes,
    input.campaigns,
    input.followUps,
    usedToday,
  );
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  forecast.offDays = [
    ...offDays(input.campaigns, today - pastDays * DAY_MS, pastDays),
    ...forecast.offDays,
  ];
  cached = { at: now.getTime(), days, pastDays, key, forecast };
  return forecast;
}
