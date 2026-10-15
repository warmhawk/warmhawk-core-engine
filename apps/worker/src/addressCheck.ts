/**
 * Pre-send address check. Before a lead's first email, asks the recipient's mail server whether
 * the mailbox exists — an SMTP conversation that stops at RCPT TO, so nothing is ever sent. A dead
 * address is stopped here instead of bouncing, and a bounce is what counts toward the bounce-rate
 * pause and wears down the sending mailbox's reputation.
 *
 * Off unless ADDRESS_CHECK_HELO is set. The check needs outbound port 25, which most home ISPs and
 * many cloud hosts block, and a host name whose reverse DNS matches this server's IP, without
 * which the big providers refuse the connection. Anything short of a clear "no such mailbox" — a
 * timeout, a greylist, a policy refusal, a server that accepts every address — comes back
 * `unknown` or `catch_all`, and the lead is sent as before.
 */
import net from 'node:net';
import { promises as dns } from 'node:dns';
import { randomBytes } from 'node:crypto';

export type AddressVerdict = 'valid' | 'invalid' | 'catch_all' | 'unknown';

export interface AddressCheckResult {
  verdict: AddressVerdict;
  /** One plain sentence on why, for the activity log. */
  detail: string;
}

export interface AddressCheckConfig {
  /** Name this server gives in EHLO; its A record and this IP's reverse DNS should match. */
  helo: string;
  /** Envelope sender for the probe. Never receives anything, but must be on a domain whose SPF
   *  allows this IP, or some servers refuse the conversation. */
  mailFrom: string;
  port?: number;
  timeoutMs?: number;
  /** Test seam: mail hosts for a domain, `null` when the domain takes no mail. */
  resolveMailHosts?: (domain: string) => Promise<string[] | null>;
}

export interface SmtpReply {
  code: number;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** A domain with more mail hosts than this is asked on its first two only. */
const MAX_HOSTS_TRIED = 2;

export function addressCheckConfig(
  env: NodeJS.ProcessEnv = process.env,
): AddressCheckConfig | null {
  const helo = env.ADDRESS_CHECK_HELO?.trim();
  if (!helo) return null;
  return { helo, mailFrom: env.ADDRESS_CHECK_MAIL_FROM?.trim() || `check@${helo}` };
}

/** The domain's mail hosts by preference, or `null` when it takes no mail at all: no such domain,
 *  a null MX (RFC 7505), or neither an MX nor an A record. Throws when DNS can't answer. */
export async function mailHosts(domain: string): Promise<string[] | null> {
  try {
    const records = await dns.resolveMx(domain);
    if (records.every((r) => r.exchange === '' || r.exchange === '.')) return null;
    return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND') return null;
    if (code !== 'ENODATA') throw err;
  }
  // No MX: mail goes to the domain's own address (RFC 5321 section 5.1).
  try {
    await dns.resolve4(domain);
    return [domain];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return null;
    throw err;
  }
}

/** Enhanced status codes that mean the mailbox itself is gone. 5.4.1 only with Microsoft's
 *  "Recipient address rejected" wording: elsewhere it can mean a relay refusal. */
const MAILBOX_GONE_CODE = /\b5\.(1\.1|1\.10|1\.6|2\.1)\b/;
const MAILBOX_GONE_TEXT =
  /5\.4\.1 recipient address rejected|no such (user|mailbox|recipient)|user unknown|unknown user|does not exist|mailbox (not found|unavailable)|recipient (unknown|not found)|invalid (mailbox|recipient)/i;
/** A rejection that is about us (our IP, our name), not the mailbox. */
const REFUSED_FOR_POLICY =
  /spamhaus|block(ed|list)|blacklist|reputation|policy|spam|5\.7\.\d+|access denied, (banned|blocked)/i;

/** Verdict from the server's answers to the real address and to a made-up one on the same domain. */
export function classifyRcpt(real: SmtpReply, madeUp: SmtpReply | null): AddressCheckResult {
  const said = `${real.code} ${real.text}`.trim().slice(0, 160);
  if (real.code >= 200 && real.code < 300) {
    return madeUp && madeUp.code >= 200 && madeUp.code < 300
      ? {
          verdict: 'catch_all',
          detail: 'the mail server accepts every address, so it can’t be told',
        }
      : { verdict: 'valid', detail: 'the mail server accepts this address' };
  }
  if (
    real.code >= 500 &&
    !REFUSED_FOR_POLICY.test(real.text) &&
    (MAILBOX_GONE_CODE.test(real.text) || MAILBOX_GONE_TEXT.test(real.text))
  ) {
    return {
      verdict: 'invalid',
      detail: `the recipient's mail server says this address doesn't exist (${said})`,
    };
  }
  return { verdict: 'unknown', detail: `the mail server gave no clear answer (${said})` };
}

/** Reads SMTP replies off a socket, joining multi-line ones ("250-…" up to "250 …"). */
function replyReader(socket: net.Socket): () => Promise<SmtpReply> {
  let buffer = '';
  let lines: string[] = [];
  const ready: SmtpReply[] = [];
  let waiting: ((reply: SmtpReply) => void) | null = null;
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('latin1');
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      lines.push(line);
      if (/^\d{3}-/.test(line)) continue;
      const reply = {
        code: Number(line.slice(0, 3)) || 0,
        text: lines.map((l) => l.slice(4)).join(' '),
      };
      lines = [];
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(reply);
      } else {
        ready.push(reply);
      }
    }
  });
  return () =>
    new Promise((resolve) => {
      const reply = ready.shift();
      if (reply) resolve(reply);
      else waiting = resolve;
    });
}

/** One SMTP conversation with `host`: greeting, EHLO, MAIL FROM, then RCPT TO for each address.
 *  Returns the RCPT replies in order. Throws on a dropped connection, the timeout, or a server
 *  that won't get as far as RCPT. Over IPv4 only: the reverse DNS is set up for the IPv4 address. */
export async function askMailServer(
  host: string,
  recipients: string[],
  config: AddressCheckConfig,
): Promise<SmtpReply[]> {
  const socket = net.connect({ host, port: config.port ?? 25, family: 4 });
  const timer = setTimeout(
    () => socket.destroy(new Error(`timed out talking to ${host}`)),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const failed = new Promise<never>((_, reject) => {
    socket.once('error', reject);
    socket.once('close', () => reject(new Error(`${host} closed the connection`)));
  });
  failed.catch(() => undefined);
  const nextReply = replyReader(socket);
  const send = (command: string | null): Promise<SmtpReply> => {
    if (command) socket.write(`${command}\r\n`);
    return Promise.race([nextReply(), failed]);
  };
  const expectOk = (reply: SmtpReply, step: string): void => {
    if (reply.code < 200 || reply.code >= 300) {
      throw new Error(`${host} refused ${step}: ${reply.code} ${reply.text}`.slice(0, 200));
    }
  };

  try {
    expectOk(await send(null), 'the connection');
    expectOk(await send(`EHLO ${config.helo}`), 'EHLO');
    expectOk(await send(`MAIL FROM:<${config.mailFrom}>`), 'MAIL FROM');
    const replies: SmtpReply[] = [];
    for (const recipient of recipients) replies.push(await send(`RCPT TO:<${recipient}>`));
    socket.write('QUIT\r\n');
    return replies;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

/** Checks one address. Never throws: anything that goes wrong is an `unknown` verdict. */
export async function checkAddress(
  email: string,
  config: AddressCheckConfig,
): Promise<AddressCheckResult> {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  let hosts: string[] | null;
  try {
    hosts = await (config.resolveMailHosts ?? mailHosts)(domain);
  } catch {
    return { verdict: 'unknown', detail: `couldn't look up ${domain}'s mail servers` };
  }
  if (!hosts)
    return { verdict: 'invalid', detail: `${domain} doesn't accept email (it has no mail server)` };

  // A made-up address on the same domain tells a real "yes" from a server that says yes to all.
  const madeUp = `check-${randomBytes(6).toString('hex')}@${domain}`;
  let lastError = 'no mail server answered';
  for (const host of hosts.slice(0, MAX_HOSTS_TRIED)) {
    try {
      const [real, fake] = await askMailServer(host, [email, madeUp], config);
      return classifyRcpt(real, fake ?? null);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { verdict: 'unknown', detail: `couldn't ask ${domain}'s mail server (${lastError})` };
}
