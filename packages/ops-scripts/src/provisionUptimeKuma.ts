/**
 * Uptime Kuma auto-provisioning — runs as the one-shot `kuma-provision` Compose service (profile:
 * "tools", see docker-compose.yml), invoked by scripts/install.sh right after `uptime-kuma` is up.
 * Closes the Infra gap where tier-config's `uptimeKumaBundled` claim ("bundled Uptime Kuma
 * container, on by default, 1-min checks against every service") shipped a blank container with
 * nothing actually configured.
 *
 * Kuma 1.x has no REST write API — monitor/notification creation only exists over Socket.IO, the
 * same protocol its own web UI uses. See uptimeKumaMonitors.ts's header comment for how the exact
 * event/payload shapes here were verified against Kuma's own source rather than guessed.
 *
 * Idempotent: `needSetup` skips admin creation once a user exists; monitors/notifications are
 * skipped by name-match rather than re-added on every install.sh re-run or `update.sh`.
 */
import { io, type Socket } from 'socket.io-client';
import {
  buildMonitorSpecs,
  findNotificationIdByName,
  namesAlreadyPresent,
  toAddMonitorPayload,
  type KumaMonitorListEntry,
  type KumaNotificationListEntry,
} from './uptimeKumaMonitors';

const KUMA_URL = process.env.UPTIME_KUMA_URL || 'http://uptime-kuma:3001';
const CONNECT_BUDGET_MS = 60_000;
const CONNECT_RETRY_DELAY_MS = 2_000;
const ACK_TIMEOUT_MS = 15_000;
const PUSH_EVENT_TIMEOUT_MS = 15_000;
const NOTIFICATION_NAME = 'WarmHawk alerts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (set by scripts/install.sh — see .env)`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AckResponse {
  ok: boolean;
  msg?: string;
  monitorID?: number;
  id?: number;
  token?: string;
}

function emitWithAck<T = AckResponse>(socket: Socket, event: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(ACK_TIMEOUT_MS).emit(event, ...args, (err: Error | null, response: T) => {
      if (err) reject(new Error(`"${event}" timed out waiting for a response: ${err.message}`));
      else resolve(response);
    });
  });
}

function waitForPushEvent<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${event}" push event after login`));
    }, PUSH_EVENT_TIMEOUT_MS);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function connectWithRetry(): Promise<Socket> {
  const deadline = Date.now() + CONNECT_BUDGET_MS;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    // 'polling' first, then upgrade — engine.io-client treats an explicit
    // transports array as attempt order, so listing 'websocket' first skips
    // the plain-HTTP handshake and opens a raw WS connection right away.
    // That's the standard socket.io connectivity pitfall: it needs the
    // Docker network path to support a WS upgrade from the first packet,
    // which real-world Docker bridge networking doesn't always deliver
    // instantly against a container that just started — confirmed live via
    // warmhawk-core-engine's own release-e2e (2026-08-28): kuma-provision
    // failed every attempt with a bare "websocket error" even with a 60s/2s
    // retry budget, never once falling back to polling to find out the
    // server was actually reachable. Polling-first matches Socket.IO's own
    // default and every Kuma automation example.
    const socket = io(KUMA_URL, { reconnection: false, timeout: 10_000, transports: ['polling', 'websocket'] });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', (err: Error) => reject(err));
      });
      return socket;
    } catch (err) {
      lastError = err as Error;
      socket.close();
      await sleep(CONNECT_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `Could not connect to Uptime Kuma at ${KUMA_URL} within ${CONNECT_BUDGET_MS / 1000}s: ${lastError?.message}`,
  );
}

async function main(): Promise<void> {
  const username = requireEnv('UPTIME_KUMA_USERNAME');
  const password = requireEnv('UPTIME_KUMA_PASSWORD');
  const postgresPassword = requireEnv('POSTGRES_PASSWORD');
  const redisPassword = requireEnv('REDIS_PASSWORD');
  const alertWebhookUrl = process.env.UPTIME_KUMA_ALERT_WEBHOOK_URL?.trim() || null;

  console.log(`[provision-uptime-kuma] connecting to ${KUMA_URL}...`);
  const socket = await connectWithRetry();
  console.log('[provision-uptime-kuma] connected.');

  try {
    const needSetup = await emitWithAck<boolean>(socket, 'needSetup');
    if (needSetup) {
      console.log('[provision-uptime-kuma] no admin account yet — running first-time setup.');
      const setupResult = await emitWithAck(socket, 'setup', username, password);
      if (!setupResult.ok) {
        throw new Error(`setup failed: ${setupResult.msg}`);
      }
    } else {
      console.log('[provision-uptime-kuma] admin account already exists — skipping setup.');
    }

    // Must be registered before `login` — the server pushes these unprompted right after a
    // successful login (see server/client.js's afterLogin -> sendMonitorList/sendNotificationList).
    const monitorListPromise = waitForPushEvent<Record<string, KumaMonitorListEntry>>(socket, 'monitorList');
    const notificationListPromise = waitForPushEvent<KumaNotificationListEntry[]>(socket, 'notificationList');

    const loginResult = await emitWithAck(socket, 'login', { username, password });
    if (!loginResult.ok) {
      throw new Error(`login failed: ${loginResult.msg ?? 'unknown error'}`);
    }
    console.log('[provision-uptime-kuma] logged in.');

    const [monitorList, notificationList] = await Promise.all([monitorListPromise, notificationListPromise]);

    let notificationIDList: Record<string, boolean> = {};
    if (alertWebhookUrl) {
      let notificationId = findNotificationIdByName(notificationList, NOTIFICATION_NAME);
      if (notificationId === null) {
        console.log(`[provision-uptime-kuma] creating "${NOTIFICATION_NAME}" webhook notification.`);
        const addResult = await emitWithAck(
          socket,
          'addNotification',
          {
            name: NOTIFICATION_NAME,
            type: 'webhook',
            isDefault: true,
            applyExisting: true,
            webhookURL: alertWebhookUrl,
            webhookContentType: 'json',
          },
          null,
        );
        if (!addResult.ok || addResult.id === undefined) {
          throw new Error(`addNotification failed: ${addResult.msg ?? 'unknown error'}`);
        }
        notificationId = addResult.id;
      } else {
        console.log(`[provision-uptime-kuma] "${NOTIFICATION_NAME}" notification already exists — reusing it.`);
      }
      notificationIDList = { [String(notificationId)]: true };
    } else {
      console.log('[provision-uptime-kuma] UPTIME_KUMA_ALERT_WEBHOOK_URL not set — monitors will have no alert target.');
    }

    const existingNames = namesAlreadyPresent(monitorList);
    // Monitors target `<COMPOSE_PROJECT_NAME>-<service>` container names rather than bare service
    // names — see buildMonitorSpecs' own comment for why bare names are unsafe now that Kuma is
    // attached to the shared `warmhawk_edge` network. Falls back to the Compose default when the
    // var is unset, matching `${COMPOSE_PROJECT_NAME:-warmhawk-core-engine}` in the compose file.
    const specs = buildMonitorSpecs({
      postgresPassword,
      redisPassword,
      containerPrefix: process.env.COMPOSE_PROJECT_NAME,
    });

    let created = 0;
    let skipped = 0;
    for (const spec of specs) {
      if (existingNames.has(spec.name)) {
        console.log(`[provision-uptime-kuma] monitor "${spec.name}" already exists — skipping.`);
        skipped += 1;
        continue;
      }
      const payload = toAddMonitorPayload(spec, notificationIDList);
      const addResult = await emitWithAck(socket, 'add', payload);
      if (!addResult.ok) {
        throw new Error(`add monitor "${spec.name}" failed: ${addResult.msg}`);
      }
      console.log(`[provision-uptime-kuma] created monitor "${spec.name}" (id ${addResult.monitorID}).`);
      created += 1;
    }

    console.log(`[provision-uptime-kuma] done — ${created} monitor(s) created, ${skipped} already present.`);
  } finally {
    socket.close();
  }
}

main().catch((err) => {
  console.error('[provision-uptime-kuma] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
