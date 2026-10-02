/**
 * Built-in unsubscribe page — where the link in a campaign email lands when the campaign has no
 * unsubscribe URL of its own (see `lib/unsubscribeToken.ts`).
 *
 * Deliberately UNAUTHENTICATED and mounted outside `/v1`: the person clicking is a recipient, not
 * a user of this instance. CAN-SPAM allows asking them for nothing beyond the address, so there is
 * no login and no form to fill in — the signed token in the URL is the whole request.
 *
 *   GET  /unsubscribe/:token — a page with one button. Changes nothing: mail scanners and link
 *                              previews fetch every URL in a message, and a GET that unsubscribed
 *                              would opt people out who never clicked.
 *   POST /unsubscribe/:token — suppresses the address. Both the button and the RFC 8058 one-click
 *                              POST a mailbox provider sends (`List-Unsubscribe-Post`) land here;
 *                              the request body is ignored either way.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { prisma } from '@warmhawk/db';
import { verifyUnsubscribeToken } from '../lib/unsubscribeToken';
import { suppressEmail } from '../lib/suppression';
import { RATE_LIMIT_UNSUBSCRIBE } from '../../../../constants';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; padding: 0 1rem; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f7f9; color: #1a1d21; }
  main { max-width: 26rem; margin: 12vh auto 0; padding: 2rem 1.5rem; background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; }
  h1 { margin: 0 0 0.75rem; font-size: 1.25rem; }
  p { margin: 0 0 1.25rem; line-height: 1.5; color: #4a5059; }
  strong { color: #1a1d21; overflow-wrap: anywhere; }
  button { font: inherit; font-weight: 600; padding: 0.65rem 1.25rem; border: 0; border-radius: 8px; background: #1a1d21; color: #fff; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</main>
</body>
</html>`;
}

function sendPage(reply: FastifyReply, statusCode: number, title: string, bodyHtml: string) {
  return reply
    .code(statusCode)
    .header('Cache-Control', 'no-store')
    .header('X-Robots-Tag', 'noindex')
    .type('text/html; charset=utf-8')
    .send(page(title, bodyHtml));
}

function sendNotFound(reply: FastifyReply) {
  return sendPage(
    reply,
    404,
    'This link is not valid',
    '<p>Reply to the email you received and ask to be removed, and the sender will take you off their list.</p>',
  );
}

function sendUnsubscribed(reply: FastifyReply, email: string | null) {
  return sendPage(
    reply,
    200,
    'You are unsubscribed',
    email
      ? `<p><strong>${escapeHtml(email)}</strong> will not get any more emails from this sender.</p>`
      : '<p>You will not get any more emails from this sender.</p>',
  );
}

/** The lead behind a token. An erased lead (GDPR) keeps its row but not its address — it is
 *  already gone from every send, so it counts as unsubscribed with nothing left to do. */
async function resolveLead(token: string) {
  const leadId = verifyUnsubscribeToken(token);
  if (!leadId) return null;
  return prisma.lead.findUnique({
    where: { id: leadId },
    select: { email: true, status: true, piiErasedAt: true },
  });
}

export async function unsubscribeRoutes(app: FastifyInstance): Promise<void> {
  // The page's own form posts form-encoded and a provider's one-click POST (RFC 8058) may be
  // form-encoded or multipart; Fastify refuses a type it has no parser for (415). Nothing in the
  // body is needed, so take any type and drop it.
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 4096 }, (_request, _body, done) =>
    done(null, {}),
  );

  const config = {
    rateLimit: { max: RATE_LIMIT_UNSUBSCRIBE.max, timeWindow: RATE_LIMIT_UNSUBSCRIBE.timeWindowMs },
  };

  app.get<{ Params: { token: string } }>('/:token', { config }, async (request, reply) => {
    const lead = await resolveLead(request.params.token);
    if (!lead) return sendNotFound(reply);
    if (lead.piiErasedAt) return sendUnsubscribed(reply, null);
    if (lead.status === 'SUPPRESSED') return sendUnsubscribed(reply, lead.email);

    return sendPage(
      reply,
      200,
      'Unsubscribe',
      `<p>Stop all emails from this sender to <strong>${escapeHtml(lead.email)}</strong>?</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`,
    );
  });

  app.post<{ Params: { token: string } }>('/:token', { config }, async (request, reply) => {
    const lead = await resolveLead(request.params.token);
    if (!lead) return sendNotFound(reply);
    if (lead.piiErasedAt) return sendUnsubscribed(reply, null);

    await suppressEmail(lead.email, {
      source: 'unsubscribe_link',
      reason: 'Unsubscribe link in a campaign email',
    });
    return sendUnsubscribed(reply, lead.email);
  });
}
