/**
 * IMAP search/flag endpoints — `GET /search`, `POST /flag`, built for the
 * warmup network's own deliverability-confirmation emails. Extended, V11, with
 * `POST /imap/fetch-reply` — genuinely new: fetches and parses a REPLY message body, not just
 * search-by-header/flag. Reused as the polling foundation for Reply Management & Unified Inbox
 * (see routes/replies.ts and lib/internalAi.ts's classify-reply call). `GET /search` matches by
 * In-Reply-To/References header (see its own comment below) rather than subject text, since this
 * repo's one caller (the reply-poll workflow) needs Message-ID-accurate threading, not a fuzzy
 * subject match.
 *
 * Internal-only pattern: guarded by `requireCallbackSecret` (n8n's warmup/reply-poll workflows
 * call these, never a public client) and, per the Containerization Model, reachable only over
 * the internal Docker network.
 */
import type { FastifyInstance } from 'fastify';
import { simpleParser } from 'mailparser';
import {
  openImapClient,
  listSpamFolders,
  encodeMessageId,
  decodeMessageId,
} from '../lib/imapClient';
import { requireCallbackSecret } from '../lib/requireCallbackSecret';

const SEARCH_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export async function imapRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCallbackSecret);

  /** Reply-poll's correlation search — matches a reply by RFC 5322 threading headers rather than
   *  subject text: a reply's In-Reply-To (and, per RFC 2822 section 3.6.4, its References) header
   *  should carry the original send's Message-ID verbatim. Checked with a single `or` query so
   *  either header threading it correctly counts as a match. */
  app.get<{ Querystring: { mailboxId?: string; providerMessageId?: string } }>(
    '/search',
    async (request, reply) => {
      const { mailboxId, providerMessageId } = request.query;
      if (!mailboxId || !providerMessageId) {
        return reply.code(422).send({ error: 'mailboxId and providerMessageId are required' });
      }

      const client = await openImapClient(mailboxId);
      try {
        const foldersToSearch = [
          'INBOX',
          ...(await withTimeout(listSpamFolders(client), SEARCH_TIMEOUT_MS, 'IMAP folder list')),
        ];

        for (const folder of foldersToSearch) {
          const lock = await client.getMailboxLock(folder);
          try {
            const uids = await withTimeout(
              client.search(
                {
                  or: [
                    { header: { 'in-reply-to': providerMessageId } },
                    { header: { references: providerMessageId } },
                  ],
                },
                { uid: true },
              ),
              SEARCH_TIMEOUT_MS,
              'IMAP search',
            );
            if (uids && uids.length > 0) {
              const uid = Math.max(...uids);
              return reply.send({ messageId: encodeMessageId(folder, uid) });
            }
          } finally {
            lock.release();
          }
        }
        return reply.send({ messageId: null });
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
  );

  app.post<{
    Body: { mailboxId?: string; messageId?: string; flags?: string[]; moveToFolder?: string };
  }>('/flag', async (request, reply) => {
    const { mailboxId, messageId, flags, moveToFolder } = request.body;
    if (!mailboxId || !messageId || !Array.isArray(flags)) {
      return reply.code(422).send({ error: 'mailboxId, messageId and flags[] are required' });
    }

    const { folder, uid } = decodeMessageId(messageId);
    const client = await openImapClient(mailboxId);
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageFlagsAdd({ uid: String(uid) }, flags, { uid: true });
        if (moveToFolder) {
          await client.messageMove({ uid: String(uid) }, moveToFolder, { uid: true });
        }
      } finally {
        lock.release();
      }
      return reply.send({ ok: true });
    } finally {
      await client.logout().catch(() => client.close());
    }
  });

  /** New, V11 — Reply Management & Unified Inbox foundation: fetches a message's plain-text
   *  body (not just its subject/flags) so `POST /internal/ai/classify-reply` has real content to
   *  classify, and `Reply.rawContent` has something to store. */
  app.post<{ Body: { mailboxId?: string; messageId?: string } }>(
    '/fetch-reply',
    async (request, reply) => {
      const { mailboxId, messageId } = request.body;
      if (!mailboxId || !messageId) {
        return reply.code(422).send({ error: 'mailboxId and messageId are required' });
      }

      const { folder, uid } = decodeMessageId(messageId);
      const client = await openImapClient(mailboxId);
      try {
        const lock = await client.getMailboxLock(folder);
        let content = '';
        try {
          const message = await withTimeout(
            client.download(String(uid), undefined, { uid: true }),
            SEARCH_TIMEOUT_MS,
            'IMAP body fetch',
          );
          if (message?.content) {
            const chunks: Buffer[] = [];
            for await (const chunk of message.content) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            // client.download() with no `part` returns the raw RFC822 source (headers, MIME
            // boundaries, quoted-printable-encoded HTML) — not the decoded plain-text body this
            // endpoint promises. Feeding that raw source straight to the classifier is fragile:
            // a keyword like "interested" can straddle a quoted-printable soft line-wrap
            // ("in=\r\nterested") and silently defeat both the regex fallback and the LLM prompt.
            // simpleParser decodes the MIME structure properly and gives us the real text body
            // (auto-generated from the HTML part when there's no separate text/plain part).
            const parsed = await simpleParser(Buffer.concat(chunks));
            content = parsed.text ?? '';
          }
        } finally {
          lock.release();
        }
        return reply.send({ content });
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
  );
}
