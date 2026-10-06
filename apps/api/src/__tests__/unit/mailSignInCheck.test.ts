/**
 * The SMTP and IMAP sign-in checks a new mailbox goes through before it's saved
 * (lib/mailSignInCheck.ts): the wording for each way they fail, the reserved test hosts they skip,
 * and real SMTP and IMAP conversations with servers on this machine that accept or refuse the
 * password.
 */
import net from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import {
  checkImapSignIn,
  checkMailboxSignIn,
  checkSmtpSignIn,
  describeSignInFailure,
  IMAP_SIGN_IN_REJECTED,
  isReservedTestHost,
  SIGN_IN_REJECTED,
} from '../../lib/mailSignInCheck';

/** Nothing a person should ever see in a popup. */
const TECHNICAL =
  /EAUTH|ECONN|ENOTFOUND|ESOCKET|535|5\.7\.8|nodemailer|imapflow|AUTHENTICATIONFAILED|_TIMEOUT|NoConnection|ERR_/i;

interface FakeSmtp {
  port: number;
  lines: string[];
  close: () => Promise<void>;
}

/** An SMTP server that offers AUTH and then accepts (235) or refuses (535) the password. */
async function startSmtpServer(acceptPassword: boolean): Promise<FakeSmtp> {
  const lines: string[] = [];
  const server = net.createServer((socket) => {
    socket.write('220 fake.test ESMTP\r\n');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let index: number;
      while ((index = buffered.indexOf('\r\n')) !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        lines.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          socket.write('250-fake.test\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (verb === 'AUTH') {
          socket.write(
            acceptPassword
              ? '235 2.7.0 Accepted\r\n'
              : '535 5.7.8 Username and Password not accepted\r\n',
          );
        } else if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    lines,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface FakeImap {
  port: number;
  lines: string[];
  close: () => Promise<void>;
}

/**
 * A plain-text IMAP server that accepts (OK) or refuses (NO [AUTHENTICATIONFAILED]) the LOGIN, the
 * way Gmail and Outlook answer a wrong password. Every other command just gets a tagged OK.
 */
async function startImapServer(acceptPassword: boolean): Promise<FakeImap> {
  const lines: string[] = [];
  const server = net.createServer((socket) => {
    socket.write('* OK IMAP4rev1 fake.test ready\r\n');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let index: number;
      while ((index = buffered.indexOf('\r\n')) !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        lines.push(line);
        const [tag, verb = ''] = line.split(' ');
        switch (verb.toUpperCase()) {
          case 'CAPABILITY':
            socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
            break;
          case 'LOGIN':
            socket.write(
              acceptPassword
                ? `${tag} OK LOGIN completed\r\n`
                : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`,
            );
            break;
          case 'LOGOUT':
            socket.end(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
            break;
          default:
            socket.write(`${tag} OK done\r\n`);
        }
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    lines,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A server that takes the connection and never says hello. */
async function startSilentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe('describeSignInFailure', () => {
  it('points Workspace and Microsoft 365 users to an app password or the Connect buttons on a refused password', () => {
    for (const error of [
      { code: 'EAUTH', responseCode: 535 },
      { code: 'EAUTH' },
      { responseCode: 535 },
      { responseCode: 534 },
    ]) {
      expect(describeSignInFailure(error, 'SMTP', 'smtp.acme.com', 587)).toBe(SIGN_IN_REJECTED);
    }
    expect(SIGN_IN_REJECTED).toMatch(/app password/);
    expect(SIGN_IN_REJECTED).toMatch(/Connect with Google or Connect with Microsoft/);
  });

  it('names the host when it does not exist', () => {
    for (const code of ['ENOTFOUND', 'EDNS', 'EAI_AGAIN']) {
      expect(describeSignInFailure({ code }, 'SMTP', 'smtp.gmial.com', 587)).toBe(
        "We couldn't find a mail server called smtp.gmial.com. Check the SMTP host.",
      );
    }
  });

  it('names the host and port when nothing answers', () => {
    for (const code of ['ECONNECTION', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'ETLS']) {
      expect(describeSignInFailure({ code }, 'SMTP', 'mail.acme.com', 2525)).toBe(
        "We couldn't connect to mail.acme.com on port 2525. Check the SMTP host and port — most mail servers use 587 or 465.",
      );
    }
    expect(describeSignInFailure({ code: 'ETIMEDOUT' }, 'SMTP', 'mail.acme.com')).toContain(
      'port 587',
    );
  });

  it('falls back to a sentence for anything else, never the server text', () => {
    const message = describeSignInFailure(
      Object.assign(new Error('Invalid greeting. response=554 go away'), { code: 'EPROTOCOL' }),
      'SMTP',
      'mail.acme.com',
      587,
    );
    expect(message).toBe(
      "The SMTP server at mail.acme.com didn't accept the sign-in. Check the SMTP host, port, username and password.",
    );
    expect(describeSignInFailure(undefined, 'SMTP', 'mail.acme.com')).toMatch(
      /didn't accept the sign-in/,
    );
  });

  it('says IMAP refused the password, and that replies could not be read', () => {
    const error = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      serverResponseCode: 'AUTHENTICATIONFAILED',
    });
    expect(describeSignInFailure(error, 'IMAP', 'imap.acme.com', 993)).toBe(IMAP_SIGN_IN_REJECTED);
    expect(IMAP_SIGN_IN_REJECTED).toMatch(/couldn't read replies/);
    // An SMTP refusal is never mistaken for an IMAP one, or the other way round.
    expect(describeSignInFailure({ code: 'EAUTH' }, 'IMAP', 'imap.acme.com')).not.toBe(
      SIGN_IN_REJECTED,
    );
    expect(describeSignInFailure({ authenticationFailed: true }, 'SMTP', 'smtp.acme.com')).not.toBe(
      IMAP_SIGN_IN_REJECTED,
    );
  });

  it("names the IMAP host and port, with IMAP's usual port, when nothing answers", () => {
    for (const code of [
      'ECONNREFUSED',
      'CONNECT_TIMEOUT',
      'GREETING_TIMEOUT',
      'ETIMEOUT',
      'NoConnection',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'ERR_SSL_WRONG_VERSION_NUMBER',
      'EPROTO',
    ]) {
      expect(describeSignInFailure({ code }, 'IMAP', 'imap.acme.com', 143)).toBe(
        "We couldn't connect to imap.acme.com on port 143. Check the IMAP host and port — most mail servers use 993.",
      );
    }
    expect(describeSignInFailure({ code: 'CONNECT_TIMEOUT' }, 'IMAP', 'imap.acme.com')).toContain(
      'port 993',
    );
  });

  it('names the IMAP host when it does not exist, and falls back to an IMAP sentence', () => {
    expect(describeSignInFailure({ code: 'ENOTFOUND' }, 'IMAP', 'imap.gmial.com', 993)).toBe(
      "We couldn't find a mail server called imap.gmial.com. Check the IMAP host.",
    );
    expect(describeSignInFailure(new Error('weird'), 'IMAP', 'imap.acme.com', 993)).toBe(
      "The IMAP server at imap.acme.com didn't accept the sign-in. Check the IMAP host, port, username and password.",
    );
  });

  it('never repeats a provider code or library name', () => {
    for (const kind of ['SMTP', 'IMAP'] as const) {
      for (const error of [
        { code: 'EAUTH', responseCode: 535 },
        { authenticationFailed: true, serverResponseCode: 'AUTHENTICATIONFAILED' },
        { code: 'ENOTFOUND' },
        { code: 'ECONNREFUSED' },
        { code: 'GREETING_TIMEOUT' },
        { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
        { code: 'EPROTOCOL' },
      ]) {
        expect(describeSignInFailure(error, kind, 'mail.acme.com', 587)).not.toMatch(TECHNICAL);
      }
    }
  });
});

describe('isReservedTestHost', () => {
  it('matches only the reserved test TLDs', () => {
    for (const host of [
      'smtp.wh-synth-abc.example',
      'smtp.fake.test',
      'mail.nowhere.invalid',
      'SMTP.X.TEST.',
    ]) {
      expect(isReservedTestHost(host)).toBe(true);
    }
    for (const host of [
      'smtp.gmail.com',
      'smtp.example.com',
      'smtp.example.net',
      'example',
      'localhost',
      '127.0.0.1',
      'smtp.testing.io',
    ]) {
      expect(isReservedTestHost(host)).toBe(false);
    }
  });
});

describe('checkSmtpSignIn — real SMTP conversation', () => {
  const servers: FakeSmtp[] = [];
  const savedDomain = process.env.WARMHAWK_DOMAIN;

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    if (savedDomain === undefined) delete process.env.WARMHAWK_DOMAIN;
    else process.env.WARMHAWK_DOMAIN = savedDomain;
  });

  it('passes when the server accepts the password, introducing itself by the install domain', async () => {
    process.env.WARMHAWK_DOMAIN = 'api.signin.example';
    const server = await startSmtpServer(true);
    servers.push(server);

    const result = await checkSmtpSignIn({
      host: '127.0.0.1',
      port: server.port,
      username: 'sam@acme.com',
      password: 'app-password',
    });
    expect(result).toBeNull();
    expect(server.lines[0]).toBe('EHLO api.signin.example');
    expect(server.lines.some((line) => line.startsWith('AUTH'))).toBe(true);
  });

  it('refuses with the app-password sentence when the server rejects the password', async () => {
    const server = await startSmtpServer(false);
    servers.push(server);

    const result = await checkSmtpSignIn({
      host: '127.0.0.1',
      port: server.port,
      username: 'sam@acme.com',
      password: 'my-normal-password',
    });
    expect(result?.message).toBe(SIGN_IN_REJECTED);
    expect((result?.cause as { responseCode?: number }).responseCode).toBe(535);
  });

  it('refuses with a host-and-port sentence when nothing listens', async () => {
    const port = await closedPort();
    const result = await checkSmtpSignIn({
      host: '127.0.0.1',
      port,
      username: 'sam@acme.com',
      password: 'pw',
    });
    expect(result?.message).toBe(
      `We couldn't connect to 127.0.0.1 on port ${port}. Check the SMTP host and port — most mail servers use 587 or 465.`,
    );
  });

  it('skips a reserved test host without dialing it', async () => {
    const result = await checkSmtpSignIn({
      host: 'smtp.wh-synth-abc.example',
      port: 587,
      username: 'sam@wh-synth-abc.example',
      password: 'pw',
    });
    expect(result).toBeNull();
  });
});

describe('checkImapSignIn — real IMAP conversation', () => {
  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('passes when the server accepts the password, and logs out', async () => {
    const server = await startImapServer(true);
    servers.push(server);

    const result = await checkImapSignIn(
      { host: '127.0.0.1', port: server.port, username: 'sam@acme.com', password: 'app-password' },
      { secure: false },
    );
    expect(result).toBeNull();
    expect(server.lines.some((line) => / LOGIN "?sam@acme\.com"? /.test(line))).toBe(true);
    expect(server.lines.some((line) => / LOGOUT$/.test(line))).toBe(true);
  });

  it('refuses with the IMAP sentence when the server rejects the password', async () => {
    const server = await startImapServer(false);
    servers.push(server);

    const result = await checkImapSignIn(
      { host: '127.0.0.1', port: server.port, username: 'sam@acme.com', password: 'wrong' },
      { secure: false },
    );
    expect(result?.kind).toBe('IMAP');
    expect(result?.message).toBe(IMAP_SIGN_IN_REJECTED);
    expect((result?.cause as { authenticationFailed?: boolean }).authenticationFailed).toBe(true);
  });

  it('refuses with a host-and-port sentence when nothing listens', async () => {
    const port = await closedPort();
    const result = await checkImapSignIn(
      { host: '127.0.0.1', port, username: 'sam@acme.com', password: 'pw' },
      { secure: false },
    );
    expect(result?.message).toBe(
      `We couldn't connect to 127.0.0.1 on port ${port}. Check the IMAP host and port — most mail servers use 993.`,
    );
  });

  it('dials with TLS by default, so a plain server is a connection failure, not a pass', async () => {
    const server = await startImapServer(true);
    servers.push(server);

    const result = await checkImapSignIn({
      host: '127.0.0.1',
      port: server.port,
      username: 'sam@acme.com',
      password: 'app-password',
    });
    expect(result?.kind).toBe('IMAP');
    expect(result?.message).toMatch(/^We couldn't connect to 127\.0\.0\.1 on port \d+\./);
    expect(server.lines.some((line) => line.includes('LOGIN'))).toBe(false);
  });

  it('skips a reserved test host without dialing it', async () => {
    const result = await checkImapSignIn({
      host: 'imap.wh-synth-abc.example',
      port: 993,
      username: 'sam@wh-synth-abc.example',
      password: 'pw',
    });
    expect(result).toBeNull();
  });
});

describe('checkMailboxSignIn — SMTP and IMAP together', () => {
  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  const signIn = (port: number) => ({
    host: '127.0.0.1',
    port,
    username: 'sam@acme.com',
    password: 'pw',
  });

  it('passes when both servers accept, and when neither is given', async () => {
    const smtp = await startSmtpServer(true);
    servers.push(smtp);
    // IMAP checked over plain text here; the TLS default is covered above.
    const imap = await startImapServer(true);
    servers.push(imap);

    expect(await checkMailboxSignIn({ smtp: signIn(smtp.port) })).toBeNull();
    expect(await checkMailboxSignIn({})).toBeNull();
    expect(
      await checkMailboxSignIn({
        smtp: signIn(smtp.port),
        imap: { ...signIn(imap.port), host: 'imap.acme.test' },
      }),
    ).toBeNull();
  });

  it('reports an IMAP refusal when SMTP signed in fine', async () => {
    const smtp = await startSmtpServer(true);
    servers.push(smtp);
    const closed = await closedPort();

    const result = await checkMailboxSignIn({ smtp: signIn(smtp.port), imap: signIn(closed) });
    expect(result?.kind).toBe('IMAP');
    expect(result?.message).toContain(`port ${closed}`);
    expect(smtp.lines.some((line) => line.startsWith('AUTH'))).toBe(true);
  });

  it('reports the SMTP refusal first when both fail', async () => {
    const smtp = await startSmtpServer(false);
    servers.push(smtp);
    const closed = await closedPort();

    const result = await checkMailboxSignIn({ smtp: signIn(smtp.port), imap: signIn(closed) });
    expect(result?.kind).toBe('SMTP');
    expect(result?.message).toBe(SIGN_IN_REJECTED);
  });

  it('checks both side by side, not one after the other', async () => {
    // Both servers take the connection and never greet, so each check waits out its 10s timeout.
    // Side by side, that's one wait; one after the other, it would be two.
    const smtpSilent = await startSilentServer();
    servers.push(smtpSilent);
    const imapSilent = await startSilentServer();
    servers.push(imapSilent);

    const started = Date.now();
    const result = await checkMailboxSignIn({
      smtp: signIn(smtpSilent.port),
      imap: signIn(imapSilent.port),
    });
    const elapsed = Date.now() - started;
    expect(result?.kind).toBe('SMTP');
    expect(result?.message).toMatch(/^We couldn't connect to 127\.0\.0\.1/);
    // One 10s greeting timeout, plus slack; two in a row would be 20s.
    expect(elapsed).toBeLessThan(16_000);
  }, 25_000);
});
