/**
 * SMTP send-trigger — the actual "send this email" step the n8n dispatch workflow calls over the
 * internal Docker network (`POST /internal/mail/send`, see `routes/internalMail.ts`). Ported
 * pattern from `outreach-infra`'s `apps/api/src/routes/mailRelay.ts` (nodemailer, OAuth2/password
 * dual auth path), rebuilt for WarmHawk's Fastify/AES-256-GCM/multi-provider-OAuth conventions and
 * extended with the compliance/guardrail hooks that were only documented, not wired to a real send
 * path, before this file existed:
 *
 *   - CAN-SPAM auto-injection gate (`sendCompliance.ts#assertCanSpamCompliant`)
 *   - RFC 8058 one-click unsubscribe headers, unconditionally attached
 *   - EU AI Act Article 50 disclosure marker
 *   - Seed-Inbox Placement Test (V12) BCC hook — every campaign send silently includes the
 *     founder/customer-configured active `SeedAccount` addresses on BCC, gracefully no-op'ing when
 *     none are configured (see `lib/seedAccounts.ts`)
 *
 * Never called directly by a public client — `requireCallbackSecret`-guarded and, per the
 * Containerization Model, reachable only over `warmhawk_internal` (nginx has no location block for
 * `/internal/*` anywhere in this repo).
 */
import nodemailer from 'nodemailer';
import { prisma } from '@warmhawk/db';
import { decrypt, loadEncryptionKey } from './encryption';
import { mintGoogleAccessToken } from './googleOAuth';
import { mintMicrosoftAccessToken } from './microsoftOAuth';
import { assertCanSpamCompliant, buildRfc8058Headers, appendEuAiDisclosureIfNeeded } from './sendCompliance';
import { getActiveSeedBccEmails } from './seedAccounts';
import { evaluateBounceCircuitBreaker } from './bounceCircuitBreaker';
import { DEFAULT_BOUNCE_RATE_THRESHOLD, BOUNCE_RATE_MIN_SAMPLE_SIZE } from '../../../../constants';

function encryptionKey() {
  return loadEncryptionKey(process.env.MAILBOX_CREDENTIAL_KEY || '');
}

export class MailSendError extends Error {
  responseCode?: number;
  code?: string;
  constructor(message: string, responseCode?: number, code?: string) {
    super(message);
    this.responseCode = responseCode;
    this.code = code;
  }
}

export interface SendMailInput {
  mailboxId: string;
  to: string;
  subject: string;
  body: string;
  /** When provided (together with `leadId`), the send is treated as a real campaign send:
   *  CAN-SPAM compliance is enforced, RFC 8058 headers are attached, the EU AI disclosure marker
   *  is considered, the Seed-Inbox Placement Test BCC hook fires, and the outcome (success/hard
   *  bounce/soft failure) is recorded onto the `Lead` row + a new `ExecutionLog` entry — this is
   *  the "handle success/failure" half of the n8n dispatch workflow, done server-side rather than
   *  in hand-authored n8n Postgres nodes (this repo's n8n workflows call this HTTP API exclusively;
   *  see n8n/workflows/README.md). Omit both for non-campaign sends (e.g. a future warmup
   *  network's own peer-to-peer emails), which intentionally skip all of the above. */
  campaignId?: string;
  leadId?: string;
  countryCode?: string;
  /** n8n's `$execution.id` — recorded onto the `ExecutionLog` row for cross-referencing a send
   *  back to the workflow execution that made it, matching `ExecutionLog.n8nExecutionId`. */
  n8nExecutionId?: string;
}

export interface SendMailResult {
  status: 'sent';
  messageId: string;
  listUnsubscribeHeader?: string;
  listUnsubscribePostHeader?: string;
  euAiDisclosureAppended: boolean;
  seedBccCount: number;
}

/** SMTP/nodemailer error message + structured fields most commonly seen on a permanent ("hard")
 *  bounce, vs. everything else being treated as transient — same heuristic list proven in
 *  `outreach-infra`'s dispatcher (`Classify Send Failure` code node), ported here since this repo
 *  does the classification server-side instead of in an n8n Code node. */
const HARD_BOUNCE_PATTERNS = [
  '550',
  '551',
  '553',
  '5.1.1',
  '5.1.10',
  '5.7.1',
  'user unknown',
  'no such user',
  'does not exist',
  'mailbox unavailable',
  'mailbox not found',
  'address rejected',
  'recipient rejected',
  'invalid recipient',
  'invalid address',
  'unknown user',
  'eenvelope',
];

function isHardBounce(message: string, code?: string): boolean {
  const haystack = `${message} ${code ?? ''}`.toLowerCase();
  return HARD_BOUNCE_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/** Guardrails — Reputation protection: `lib/bounceCircuitBreaker.ts`'s `evaluateBounceCircuitBreaker`
 *  shipped as real, unit-tested pure logic with zero production callers before this pass. Called
 *  after every hard bounce is recorded; recomputes and applies two independent breakers —
 *  mailbox-level (reputation flag, `Mailbox.rollingBounceRate`/`autoFlaggedAt`, uses the instance
 *  default threshold since a mailbox is shared across campaigns) and campaign-level
 *  (`Campaign.pausedForBounceRate`, uses that campaign's own configurable threshold). Never
 *  throws — evaluating a breaker must not itself fail the send-failure recording it runs after. */
async function applyBounceCircuitBreaker(params: {
  campaignId: string;
  mailboxId: string;
}): Promise<void> {
  const { campaignId, mailboxId } = params;

  const [mailboxSent, mailboxBounced, campaignSent, campaignBounced, campaign] = await Promise.all([
    prisma.executionLog.count({ where: { mailboxId, status: 'SENT' } }),
    prisma.executionLog.count({ where: { mailboxId, status: 'BOUNCED' } }),
    prisma.executionLog.count({ where: { campaignId, status: 'SENT' } }),
    prisma.executionLog.count({ where: { campaignId, status: 'BOUNCED' } }),
    prisma.campaign.findUnique({ where: { id: campaignId } }),
  ]);

  const mailboxResult = evaluateBounceCircuitBreaker(
    { sent: mailboxSent + mailboxBounced, bounced: mailboxBounced },
    DEFAULT_BOUNCE_RATE_THRESHOLD,
    BOUNCE_RATE_MIN_SAMPLE_SIZE,
  );
  const mailboxUpdate: { rollingBounceRate: number; status?: 'PAUSED'; autoFlaggedAt?: Date } = {
    rollingBounceRate: mailboxResult.bounceRate,
  };
  if (mailboxResult.shouldPause) {
    mailboxUpdate.status = 'PAUSED';
    mailboxUpdate.autoFlaggedAt = new Date();
  }
  await prisma.mailbox.update({ where: { id: mailboxId }, data: mailboxUpdate }).catch(() => undefined);

  if (campaign && !campaign.pausedForBounceRate) {
    const campaignResult = evaluateBounceCircuitBreaker(
      { sent: campaignSent + campaignBounced, bounced: campaignBounced },
      campaign.bounceRateThreshold,
    );
    if (campaignResult.shouldPause) {
      await prisma.campaign
        .update({ where: { id: campaignId }, data: { pausedForBounceRate: true } })
        .catch(() => undefined);
    }
  }
}

/** Max retry attempts before a lead is suppressed rather than retried again — matches
 *  `outreach-infra`'s dispatcher (`retryCount + 1 >= 4`). Exponential backoff, capped at 48h, with
 *  +/-10% jitter, same formula. */
const MAX_RETRY_ATTEMPTS = 4;
const BASE_RETRY_DELAY_SECONDS = 1800; // 30 minutes
const MAX_RETRY_DELAY_SECONDS = 172_800; // 48 hours

function computeRetryDelaySeconds(priorRetryCount: number): number {
  const exponential = BASE_RETRY_DELAY_SECONDS * 2 ** priorRetryCount;
  const jittered = exponential * (0.9 + Math.random() * 0.2);
  return Math.min(jittered, MAX_RETRY_DELAY_SECONDS);
}

/** Records a failed send: classifies hard vs. soft, logs an `ExecutionLog` row, and transitions
 *  the `Lead` accordingly (hard bounce -> BOUNCED; soft failure -> retry with backoff, or
 *  SUPPRESSED once `MAX_RETRY_ATTEMPTS` is exhausted). Never throws — a failure recording a
 *  failure must not itself crash the request. */
async function recordSendFailure(params: {
  campaignId: string;
  leadId: string;
  mailboxId: string;
  n8nExecutionId?: string;
  message: string;
  code?: string;
}): Promise<void> {
  const { campaignId, leadId, mailboxId, n8nExecutionId, message, code } = params;
  const hard = isHardBounce(message, code);

  if (hard) {
    await prisma.lead.update({ where: { id: leadId }, data: { status: 'BOUNCED' } }).catch(() => undefined);
    await prisma.executionLog
      .create({
        data: { campaignId, leadId, mailboxId, n8nExecutionId, status: 'BOUNCED', errorMessage: message },
      })
      .catch(() => undefined);
    await applyBounceCircuitBreaker({ campaignId, mailboxId }).catch(() => undefined);
    return;
  }

  const lead = await prisma.lead.findUnique({ where: { id: leadId } }).catch(() => null);
  const priorRetryCount = lead?.retryCount ?? 0;
  const exhausted = priorRetryCount + 1 >= MAX_RETRY_ATTEMPTS;

  await prisma.lead
    .update({
      where: { id: leadId },
      data: exhausted
        ? { status: 'SUPPRESSED', retryCount: { increment: 1 }, nextRetryAt: null }
        : {
            status: 'QUEUED',
            retryCount: { increment: 1 },
            nextRetryAt: new Date(Date.now() + computeRetryDelaySeconds(priorRetryCount) * 1000),
            queuedJobId: null,
            queuedSlotAt: null,
          },
    })
    .catch(() => undefined);

  await prisma.executionLog
    .create({
      data: { campaignId, leadId, mailboxId, n8nExecutionId, status: 'FAILED', errorMessage: message },
    })
    .catch(() => undefined);
}

/** Resolves a WarmHawk-templated unsubscribe URL/mailto for a specific recipient. Campaign
 *  templates may embed a `{{email}}` placeholder (e.g.
 *  `https://api.customer-domain.com/unsubscribe?email={{email}}`); a template with no placeholder
 *  is used as-is (a single shared unsubscribe landing page is still RFC 8058-valid). */
function resolveUnsubscribeUrl(template: string, recipientEmail: string): string {
  return template.replace(/\{\{\s*email\s*\}\}/gi, encodeURIComponent(recipientEmail));
}

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const { mailboxId, to, subject, campaignId, leadId, countryCode, n8nExecutionId } = input;
  let body = input.body;

  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw new MailSendError('Mailbox not found', 404);

  const hasCredential = Boolean(mailbox.oauthRefreshTokenEncrypted || mailbox.authPasswordEncrypted);
  if (!mailbox.smtpHost || !mailbox.smtpPort || !mailbox.authUsername || !hasCredential) {
    throw new MailSendError('Mailbox is missing SMTP credentials', 502);
  }

  let listUnsubscribeHeader: string | undefined;
  let listUnsubscribePostHeader: string | undefined;
  let euAiDisclosureAppended = false;
  let seedBccCount = 0;
  let bccList: string[] = [];

  // Campaign sends only — compliance gates + guardrail hooks never apply to a non-campaign send
  // (e.g. the warmup network's own peer-to-peer traffic).
  if (campaignId) {
    const [campaign, instanceSettings] = await Promise.all([
      prisma.campaign.findUnique({ where: { id: campaignId } }),
      prisma.instanceSettings.findUnique({ where: { id: 'default' } }),
    ]);
    if (!campaign) throw new MailSendError('Campaign not found', 404);

    // CAN-SPAM auto-injection — refuses to send a campaign missing either required element. This
    // is the one shared send path every entry point (API route, CSV import, webhook ingest,
    // dashboard) ultimately funnels through, so the gate cannot be bypassed.
    assertCanSpamCompliant({
      physicalMailingAddress: instanceSettings?.physicalMailingAddress,
      unsubscribeUrlTemplate: campaign.unsubscribeUrlTemplate,
    });

    const unsubscribeUrl = resolveUnsubscribeUrl(campaign.unsubscribeUrlTemplate as string, to);
    const rfc8058 = buildRfc8058Headers(unsubscribeUrl);
    listUnsubscribeHeader = rfc8058['List-Unsubscribe'];
    listUnsubscribePostHeader = rfc8058['List-Unsubscribe-Post'];

    const disclosure = appendEuAiDisclosureIfNeeded(body, Boolean(campaign.aiProvider), {
      email: to,
      countryCode,
    });
    body = disclosure.body;
    euAiDisclosureAppended = disclosure.disclosureAppended;

    // Seed-Inbox Placement Test (V12, Guardrails option (c)) — BCC every active, founder/customer-
    // configured seed account on every real campaign send. Gracefully no-ops (empty array) when
    // none are configured, exactly per the spec ("this is customer/founder-configured, not
    // something requiring live seed accounts to exist in THIS build").
    bccList = await getActiveSeedBccEmails();
    seedBccCount = bccList.length;
  }

  const key = encryptionKey();

  let auth:
    | { type: 'OAuth2'; user: string; accessToken: string }
    | { user: string; pass: string };

  if (mailbox.oauthRefreshTokenEncrypted) {
    const refreshToken = decrypt(mailbox.oauthRefreshTokenEncrypted, key);
    const accessToken =
      mailbox.provider === 'MICROSOFT_365'
        ? await mintMicrosoftAccessToken(refreshToken)
        : await mintGoogleAccessToken(refreshToken);
    auth = { type: 'OAuth2', user: mailbox.authUsername, accessToken };
  } else {
    auth = { user: mailbox.authUsername, pass: decrypt(mailbox.authPasswordEncrypted as string, key) };
  }

  const transporter = nodemailer.createTransport({
    host: mailbox.smtpHost,
    port: mailbox.smtpPort,
    secure: mailbox.smtpPort === 465,
    auth,
  });

  const headers: Record<string, string> = {};
  if (listUnsubscribeHeader) headers['List-Unsubscribe'] = listUnsubscribeHeader;
  if (listUnsubscribePostHeader) headers['List-Unsubscribe-Post'] = listUnsubscribePostHeader;

  try {
    const info = await transporter.sendMail({
      from: mailbox.email,
      to,
      ...(bccList.length > 0 ? { bcc: bccList } : {}),
      subject,
      text: body,
      headers,
    });

    if (campaignId) {
      await prisma.mailbox.update({
        where: { id: mailboxId },
        data: { sentToday: { increment: 1 }, lastSentAt: new Date() },
      });

      if (leadId) {
        // "Handle success" half of the dispatch pipeline — mirrors outreach-infra's "Mark Lead
        // Contacted" + "Log Sent Execution" Postgres nodes, done server-side here instead.
        await prisma.lead
          .update({
            where: { id: leadId },
            data: { status: 'CONTACTED', retryCount: 0, nextRetryAt: null },
          })
          .catch(() => undefined);
        await prisma.executionLog
          .create({
            data: {
              campaignId,
              leadId,
              mailboxId,
              n8nExecutionId,
              status: 'SENT',
              // Privacy fix (BYOK guardrail — "generated content is never persisted or logged by
              // WarmHawk beyond the immediate send"): this previously stored the full
              // `{ subject, body }`, including AI-personalized/spintax-rendered text, permanently.
              // Only non-content length metadata is kept now — enough to spot an anomaly (e.g. an
              // empty body actually went out) without ever retaining the content itself.
              payloadSent: { subjectLength: subject.length, bodyLength: body.length },
              // Reply-poll correlation: an opaque provider-assigned id, not personalized content —
              // storing it doesn't reopen the privacy fix above. Lets `replies.ts`'s `/pending`
              // route hand the n8n reply-poll workflow a real IMAP In-Reply-To/References search
              // target instead of reconstructing one from the (no-longer-persisted) subject line.
              providerMessageId: info.messageId,
              listUnsubscribeHeader,
              listUnsubscribePostHeader,
              euAiDisclosureAppended,
            },
          })
          .catch(() => undefined);
      }
    }

    return {
      status: 'sent',
      messageId: info.messageId,
      listUnsubscribeHeader,
      listUnsubscribePostHeader,
      euAiDisclosureAppended,
      seedBccCount,
    };
  } catch (err) {
    // nodemailer SMTP errors carry a structured responseCode (e.g. 550) and code (e.g.
    // "EENVELOPE", "ETIMEDOUT") alongside the free-text message — surface both so callers can
    // classify hard vs. soft failures without string-matching the message as their only signal,
    // matching outreach-infra's proven pattern.
    const smtpErr = err as { responseCode?: number; code?: string; message?: string };
    const message = err instanceof Error ? err.message : 'Failed to send email';

    if (campaignId && leadId) {
      // "Handle failure" half of the dispatch pipeline.
      await recordSendFailure({
        campaignId,
        leadId,
        mailboxId,
        n8nExecutionId,
        message,
        code: smtpErr?.code,
      });
    }

    throw new MailSendError(message, smtpErr?.responseCode ?? 502, smtpErr?.code);
  }
}
