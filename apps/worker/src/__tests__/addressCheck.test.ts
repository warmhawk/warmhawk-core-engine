import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import {
  addressCheckConfig,
  checkAddress,
  classifyRcpt,
  type AddressCheckConfig,
} from '../addressCheck';

// Real replies captured from Google, Microsoft 365 and a Postfix host on 2026-10-14.
const GMAIL_NO_SUCH_USER = {
  code: 550,
  text: "5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient's email address",
};
const GMAIL_DISABLED = {
  code: 550,
  text: '5.2.1 The email account that you tried to reach is inactive.',
};
const M365_NO_SUCH_USER = {
  code: 550,
  text: '5.4.1 Recipient address rejected: Access denied. For more information see https://aka.ms/EXOSmtpErrors',
};
const POSTFIX_NO_SUCH_USER = {
  code: 550,
  text: '5.1.1 <support@example.org>: Recipient address rejected: User unknown in virtual mailbox table',
};
const OK = { code: 250, text: '2.1.5 OK' };

describe('classifyRcpt', () => {
  it('calls an address dead on the mailbox-gone replies of the big providers', () => {
    for (const reply of [
      GMAIL_NO_SUCH_USER,
      GMAIL_DISABLED,
      M365_NO_SUCH_USER,
      POSTFIX_NO_SUCH_USER,
    ]) {
      expect(classifyRcpt(reply, reply).verdict).toBe('invalid');
    }
  });

  it('tells an accepted address from a server that accepts every address', () => {
    expect(classifyRcpt(OK, GMAIL_NO_SUCH_USER).verdict).toBe('valid');
    expect(classifyRcpt(OK, OK).verdict).toBe('catch_all');
  });

  it('never calls an address dead over a refusal aimed at the sender', () => {
    const blocked = {
      code: 554,
      text: '5.7.1 Service unavailable; Client host blocked using zen.spamhaus.org',
    };
    const relay = { code: 554, text: '5.4.1 Relay access denied' };
    const greylisted = { code: 450, text: '4.2.0 Greylisted, please try again later' };
    expect(classifyRcpt(blocked, blocked).verdict).toBe('unknown');
    expect(classifyRcpt(relay, relay).verdict).toBe('unknown');
    expect(classifyRcpt(greylisted, greylisted).verdict).toBe('unknown');
  });
});

describe('addressCheckConfig', () => {
  it('is off until a HELO name is set, and defaults the sender to that name', () => {
    expect(addressCheckConfig({})).toBeNull();
    expect(addressCheckConfig({ ADDRESS_CHECK_HELO: ' mx.example.net ' })).toEqual({
      helo: 'mx.example.net',
      mailFrom: 'check@mx.example.net',
    });
  });
});

/** A fake mail server that knows only `known`, or every address when `acceptAll`. Records what
 *  it was sent, so a test can see nothing past RCPT TO ever goes out. */
function fakeMailServer(opts: {
  known?: string[];
  acceptAll?: boolean;
  greeting?: string;
  silent?: boolean;
}) {
  const received: string[] = [];
  const server = net.createServer((socket) => {
    if (opts.silent) return;
    socket.write(`${opts.greeting ?? '220 mx.test ESMTP'}\r\n`);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        received.push(line);
        if (line.startsWith('EHLO'))
          socket.write('250-mx.test\r\n250-SIZE 1000\r\n250 8BITMIME\r\n');
        else if (line.startsWith('MAIL FROM')) socket.write('250 2.1.0 OK\r\n');
        else if (line.startsWith('RCPT TO')) {
          const address = line.slice('RCPT TO:<'.length, -1);
          socket.write(
            opts.acceptAll || opts.known?.includes(address)
              ? '250 2.1.5 OK\r\n'
              : '550-5.1.1 The email account that you tried to reach does not exist.\r\n550 5.1.1 Please check it.\r\n',
          );
        } else if (line === 'QUIT') socket.end('221 2.0.0 Bye\r\n');
      }
    });
  });
  return new Promise<{ port: number; received: string[]; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ port, received, close: () => server.close() });
    });
  });
}

describe('checkAddress against a mail server', () => {
  let close: (() => void) | null = null;
  afterEach(() => close?.());

  async function setUp(
    opts: Parameters<typeof fakeMailServer>[0],
    overrides: Partial<AddressCheckConfig> = {},
  ) {
    const server = await fakeMailServer(opts);
    close = server.close;
    const config: AddressCheckConfig = {
      helo: 'check.test',
      mailFrom: 'check@check.test',
      port: server.port,
      timeoutMs: 2000,
      resolveMailHosts: async () => ['127.0.0.1'],
      ...overrides,
    };
    return { server, config };
  }

  it('finds a dead mailbox and never gets past RCPT TO', async () => {
    const { server, config } = await setUp({ known: ['ana@shop.test'] });
    const result = await checkAddress('bob@shop.test', config);
    expect(result.verdict).toBe('invalid');
    expect(result.detail).toContain('5.1.1');
    expect(server.received.some((line) => line.startsWith('DATA'))).toBe(false);
    expect(server.received[0]).toBe('EHLO check.test');
  });

  it('passes a real mailbox, and flags a server that accepts anything', async () => {
    const known = await setUp({ known: ['ana@shop.test'] });
    expect((await checkAddress('ana@shop.test', known.config)).verdict).toBe('valid');
    close?.();
    const any = await setUp({ acceptAll: true });
    expect((await checkAddress('ana@shop.test', any.config)).verdict).toBe('catch_all');
  });

  it('calls a domain with no mail server dead without connecting anywhere', async () => {
    const { server, config } = await setUp({}, { resolveMailHosts: async () => null });
    expect((await checkAddress('ana@gone.test', config)).verdict).toBe('invalid');
    expect(server.received).toEqual([]);
  });

  it('comes back unknown — never throws — on a refused greeting, a timeout or a DNS failure', async () => {
    const refusing = await setUp({ greeting: '554 5.7.1 No thanks' });
    expect((await checkAddress('ana@shop.test', refusing.config)).verdict).toBe('unknown');
    close?.();
    const silent = await setUp({ silent: true }, { timeoutMs: 200 });
    expect((await checkAddress('ana@shop.test', silent.config)).verdict).toBe('unknown');
    close?.();
    const noDns = await setUp(
      {},
      {
        resolveMailHosts: async () => {
          throw Object.assign(new Error('queryMx ESERVFAIL'), { code: 'ESERVFAIL' });
        },
      },
    );
    expect((await checkAddress('ana@shop.test', noDns.config)).verdict).toBe('unknown');
  });
});
