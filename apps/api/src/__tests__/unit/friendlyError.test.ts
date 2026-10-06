/**
 * Popup wording (lib/friendlyError.ts): whatever a route lets escape, the reply says it in plain
 * words — never Prisma's "Unique constraint failed…" or a library's stack text. Prisma errors are
 * built by shape (name/code/meta), the same way the real client's classes look at runtime.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@warmhawk/db', () => ({ prisma: {} }));

import { describeMailFailure, toFriendlyError } from '../../lib/friendlyError';

function prismaKnown(code: string, meta?: Record<string, unknown>) {
  return Object.assign(new Error('\nInvalid `prisma.mailbox.create()` invocation:\n\n…'), {
    name: 'PrismaClientKnownRequestError',
    code,
    meta,
  });
}

describe('toFriendlyError', () => {
  it('names the duplicate for a unique-constraint failure', () => {
    expect(
      toFriendlyError(prismaKnown('P2002', { modelName: 'Mailbox', target: ['email'] })),
    ).toEqual({ statusCode: 409, message: 'This mailbox is already connected.' });
    expect(toFriendlyError(prismaKnown('P2002', { modelName: 'Domain' })).message).toBe(
      'This domain is already added.',
    );
  });

  it('falls back to a plain duplicate sentence for a model it has no wording for', () => {
    const { statusCode, message } = toFriendlyError(prismaKnown('P2002', { modelName: 'Other' }));
    expect(statusCode).toBe(409);
    expect(message).toMatch(/^That already exists/);
  });

  it('turns record-not-found into a 404 with a reload hint', () => {
    const { statusCode, message } = toFriendlyError(prismaKnown('P2025'));
    expect(statusCode).toBe(404);
    expect(message).toMatch(/may have been deleted/);
  });

  it('turns a broken link (foreign key) into a 409', () => {
    expect(toFriendlyError(prismaKnown('P2003')).statusCode).toBe(409);
  });

  it('says the database is unreachable when Prisma cannot connect', () => {
    const err = Object.assign(new Error("Can't reach database server at `db:5432`"), {
      name: 'PrismaClientInitializationError',
    });
    const { statusCode, message } = toFriendlyError(err);
    expect(statusCode).toBe(503);
    expect(message).toMatch(/can't reach its database/);
  });

  it('hides a Prisma validation error behind the generic sentence', () => {
    const err = Object.assign(new Error('Argument `name` is missing.'), {
      name: 'PrismaClientValidationError',
    });
    expect(toFriendlyError(err)).toEqual({
      statusCode: 500,
      message: expect.stringMatching(/^Something went wrong on our side/),
    });
  });

  it("maps Fastify's upload and body limits", () => {
    const tooLarge = Object.assign(new Error('request file too large'), {
      code: 'FST_REQ_FILE_TOO_LARGE',
      statusCode: 413,
    });
    expect(toFriendlyError(tooLarge)).toEqual({
      statusCode: 413,
      message: 'That file is too large. The limit is 10 MB.',
    });
  });

  it('rewords the rate limit', () => {
    const limited = Object.assign(new Error('Rate limit exceeded, retry in 1 minute'), {
      statusCode: 429,
    });
    expect(toFriendlyError(limited).message).toMatch(/Wait a minute/);
  });

  it('keeps the wording of a 4xx raised on purpose', () => {
    const err = Object.assign(new Error('Mailbox not found'), { statusCode: 404 });
    expect(toFriendlyError(err)).toEqual({ statusCode: 404, message: 'Mailbox not found' });
  });

  it('never passes a 500 through verbatim', () => {
    const { statusCode, message } = toFriendlyError(
      new TypeError("Cannot read properties of undefined (reading 'id')"),
    );
    expect(statusCode).toBe(500);
    expect(message).not.toMatch(/Cannot read/);
  });
});

describe('describeMailFailure', () => {
  it('asks for a reconnect when the server refused the sign-in', () => {
    const err = {
      code: 'EAUTH',
      responseCode: 535,
      message: '535-5.7.8 Username and Password not accepted',
    };
    expect(describeMailFailure(err)).toMatch(/rejected this mailbox's sign-in/);
  });

  it('points at host and port when the server could not be reached', () => {
    expect(describeMailFailure({ code: 'ETIMEDOUT' })).toMatch(/SMTP host and port/);
  });

  it('separates a temporary refusal from a permanent one', () => {
    expect(describeMailFailure({ responseCode: 421 })).toMatch(/busy or limiting/);
    expect(describeMailFailure({ responseCode: 554 })).toMatch(/refused to send/);
  });

  it('never repeats the provider text', () => {
    expect(describeMailFailure(new Error('Unexpected socket close'))).not.toMatch(/socket/);
  });
});
