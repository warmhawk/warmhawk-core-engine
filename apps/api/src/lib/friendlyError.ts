/**
 * The sentence a person sees when a request fails in a way no route handled itself.
 *
 * The dashboard shows core's `{ error }` text as-is in its popups, and the global error handler
 * used to send `error.message` verbatim — so a duplicate mailbox surfaced as "Invalid
 * `prisma.mailbox.create()` invocation: Unique constraint failed on the fields: (`email`)". This
 * maps the failures that can actually reach a person (Prisma, Fastify's body/upload/rate limits,
 * anything unexpected) to plain words and the right status. The raw error still goes to the log.
 */
import { connectionErrorFor } from './mailboxConnectionHealth';

export interface FriendlyError {
  statusCode: number;
  message: string;
}

const SOMETHING_WENT_WRONG =
  'Something went wrong on our side. Try again in a minute — if it keeps happening, check the WarmHawk server logs.';
const DATABASE_UNREACHABLE =
  "WarmHawk can't reach its database right now. Try again in a minute — if it keeps happening, check that the database container is running.";
const NOT_FOUND =
  "We couldn't find that — it may have been deleted. Reload the page and try again.";

export const MAILBOX_ALREADY_CONNECTED = 'This mailbox is already connected.';

/** "That address is already …" per model + unique field, from Prisma's P2002 `meta`. */
const DUPLICATE_BY_MODEL: Record<string, string> = {
  Mailbox: MAILBOX_ALREADY_CONNECTED,
  Domain: 'This domain is already added.',
  Lead: 'This lead is already in this campaign.',
  SuppressionEntry: 'This address is already on the blocked list.',
  SeedAccount: 'This test inbox is already added.',
  User: 'An account with this email already exists.',
  CampaignStep: 'Two follow-up steps ended up in the same position. Reload the page and try again.',
  AiProviderKey: 'A key for this AI provider is already saved.',
  OAuthClientConfig: 'An OAuth app for this provider is already saved.',
};

interface PrismaLikeError {
  name?: string;
  code?: string;
  meta?: { modelName?: string; target?: unknown };
}

function isPrismaError(error: PrismaLikeError): boolean {
  return typeof error.name === 'string' && error.name.startsWith('PrismaClient');
}

function fromPrisma(error: PrismaLikeError): FriendlyError {
  if (error.name === 'PrismaClientInitializationError') {
    return { statusCode: 503, message: DATABASE_UNREACHABLE };
  }
  if (error.name !== 'PrismaClientKnownRequestError') {
    // Validation/unknown/panic errors are bugs in the request we built, not something the
    // person did — nothing in their wording would help them.
    return { statusCode: 500, message: SOMETHING_WENT_WRONG };
  }
  switch (error.code) {
    case 'P2002':
      return {
        statusCode: 409,
        message:
          DUPLICATE_BY_MODEL[error.meta?.modelName ?? ''] ??
          'That already exists. Change it or reload the page to see the existing one.',
      };
    case 'P2025':
    case 'P2001':
    case 'P2015':
      return { statusCode: 404, message: NOT_FOUND };
    case 'P2003':
    case 'P2014':
      return {
        statusCode: 409,
        message:
          'Something this is linked to was changed or deleted. Reload the page and try again.',
      };
    case 'P2000':
      return {
        statusCode: 400,
        message: 'One of the values is too long. Shorten it and try again.',
      };
    case 'P2005':
    case 'P2006':
    case 'P2007':
    case 'P2023':
      return { statusCode: 400, message: "One of the values isn't valid. Check it and try again." };
    case 'P2024':
    case 'P1001':
    case 'P1002':
    case 'P1008':
    case 'P1017':
      return { statusCode: 503, message: DATABASE_UNREACHABLE };
    case 'P2034':
      return {
        statusCode: 409,
        message: 'Someone else changed this at the same moment. Try again.',
      };
    default:
      return { statusCode: 500, message: SOMETHING_WENT_WRONG };
  }
}

/** Fastify's own codes for requests it refuses before a route runs. */
const FASTIFY_MESSAGES: Record<string, string> = {
  FST_REQ_FILE_TOO_LARGE: 'That file is too large. The limit is 10 MB.',
  FST_ERR_CTP_BODY_TOO_LARGE: 'That is too much data to send at once. Try a smaller amount.',
  FST_FILES_LIMIT: 'Upload one file at a time.',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "That kind of upload isn't supported.",
  FST_ERR_CTP_EMPTY_JSON_BODY: 'The request was empty. Reload the page and try again.',
  FST_ERR_CTP_INVALID_JSON_BODY: "The request couldn't be read. Reload the page and try again.",
  FST_ERR_VALIDATION: "Some of the details sent aren't valid. Check them and try again.",
};

/** Maps any thrown error to a status code and a sentence safe to show a person. */
export function toFriendlyError(error: unknown): FriendlyError {
  const err = (error ?? {}) as PrismaLikeError & {
    statusCode?: number;
    message?: string;
    validation?: unknown;
  };

  if (isPrismaError(err)) return fromPrisma(err);

  const known = err.code ? FASTIFY_MESSAGES[err.code] : undefined;
  if (known) return { statusCode: err.statusCode ?? 400, message: known };
  if (err.validation) {
    return { statusCode: 400, message: FASTIFY_MESSAGES.FST_ERR_VALIDATION };
  }

  const statusCode = err.statusCode ?? 500;
  if (statusCode === 429) {
    return {
      statusCode,
      message: 'Too many requests in a short time. Wait a minute and try again.',
    };
  }
  // A 4xx someone raised on purpose (`httpErrors`, a route's own throw) already says what's
  // wrong. A 5xx is whatever broke underneath — library text, stack details — so it's replaced.
  if (statusCode < 500 && err.message) return { statusCode, message: err.message };
  return { statusCode: statusCode >= 500 ? statusCode : 500, message: SOMETHING_WENT_WRONG };
}

interface MailFailureShape {
  code?: string;
  responseCode?: number;
}

const NETWORK_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EDNS',
  'EAI_AGAIN',
  'ETLS',
]);

/** The sentence for a send that failed — used where a person pressed a button and is waiting
 *  (e.g. "Send me a test"). The provider's own text ("535-5.7.8 Username and Password not
 *  accepted…") stays in the send log. */
export function describeMailFailure(error: unknown): string {
  const reconnect = connectionErrorFor(error);
  if (reconnect) return reconnect;
  const failure = (error ?? {}) as MailFailureShape;
  if (failure.code && NETWORK_CODES.has(failure.code)) {
    return "Couldn't reach this mailbox's mail server. Check its SMTP host and port, then try again.";
  }
  const status = failure.responseCode ?? 0;
  if (status >= 400 && status < 500) {
    return 'The mail server is busy or limiting sends right now. Try again in a few minutes.';
  }
  if (status >= 500 && status < 600) {
    return "The mail server refused to send this email. Check that the mailbox can send from your email provider's own app, then try again.";
  }
  return "The email couldn't be sent. Try again in a minute — if it keeps failing, reconnect this mailbox.";
}
