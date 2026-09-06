/**
 * The "1-minute checks against every service" set (tier-config's `uptimeKumaBundled` claim) —
 * every internal-network service this package ships, minus postgres/redis which get their own
 * native Kuma monitor types (not HTTP) below.
 *
 * Field shapes verified against louislam/uptime-kuma's own client defaults
 * (src/pages/EditMonitor.vue `monitorDefaults`) and server-side handlers (server/server.js's
 * `add` socket event, server/monitor-types/postgres.js, server/monitor-types/redis.js) — Kuma 1.x
 * has no REST write API, only Socket.IO, so there's no OpenAPI spec to check this against; this
 * comment is the audit trail instead.
 */
export interface KumaMonitorSpec {
  name: string;
  type: 'http' | 'postgres' | 'redis';
  url?: string;
  databaseConnectionString?: string;
}

export interface PasswordEnv {
  postgresPassword: string;
  redisPassword: string;
  /**
   * Compose project name, mirroring `${COMPOSE_PROJECT_NAME:-warmhawk-core-engine}` in
   * docker/docker-compose.yml, where every monitored service sets
   * `container_name: <prefix>-<service>`. Optional so the default matches that same Compose
   * fallback rather than forcing every caller to thread it through.
   */
  containerPrefix?: string;
}

export const DEFAULT_CONTAINER_PREFIX = 'warmhawk-core-engine';

/**
 * Bug fix (2026-09-06): these targets used to be bare Compose service names (`nginx`, `api`,
 * `postgres`, …). That was only safe while uptime-kuma sat on `warmhawk_internal` alone. The
 * 2026-09-06 egress fix (see uptime-kuma's `networks:` in docker/docker-compose.yml) also attached
 * it to `warmhawk_edge` — a SHARED network that other Compose projects on the same box join, each
 * registering its own nginx under the very same bare `nginx` alias. Docker's embedded DNS then
 * answers `nginx` with ALL of them round-robin, so Kuma health-checks a random stranger's container.
 *
 * Observed live on SaaS-Production: `WarmHawk — nginx (edge)` flapped Down/Up every few minutes,
 * alternating `404` (a different project's nginx, which has no /health route) and `ECONNREFUSED`
 * (a shared edge proxy with no :80 listener) — while the real nginx was up the entire time. With
 * maxretries=3 and 2 of 3 candidates wrong, roughly a third of check cycles tripped a false alarm.
 *
 * Container names are unique per box (Docker refuses to start a duplicate) and are registered on
 * EVERY network a container joins, so they resolve unambiguously from Kuma no matter how many
 * networks it is attached to. Only the project prefix varies.
 */
export function buildMonitorSpecs(env: PasswordEnv): KumaMonitorSpec[] {
  const prefix = env.containerPrefix?.trim() || DEFAULT_CONTAINER_PREFIX;
  return [
    { name: 'WarmHawk — nginx (edge)', type: 'http', url: `http://${prefix}-nginx:80/health` },
    { name: 'WarmHawk — api', type: 'http', url: `http://${prefix}-api:4600/health` },
    { name: 'WarmHawk — n8n', type: 'http', url: `http://${prefix}-n8n:5678/healthz` },
    {
      name: 'WarmHawk — postgres',
      type: 'postgres',
      databaseConnectionString: `postgresql://warmhawk:${env.postgresPassword}@${prefix}-postgres:5432/warmhawk`,
    },
    {
      name: 'WarmHawk — redis',
      type: 'redis',
      // Bug fix (2026-09-04): REDIS_PASSWORD can contain `/` (openssl rand -base64's alphabet),
      // which breaks URL parsing when interpolated raw into a `redis://` connection string —
      // both here (Kuma itself parses this string with a URL parser server-side) and in
      // apps/worker's own connection (see apps/worker/src/queue.ts's buildRedisUrl). Encode it.
      databaseConnectionString: `redis://:${encodeURIComponent(env.redisPassword)}@${prefix}-redis:6379`,
    },
  ];
}

/**
 * Builds the exact payload `add`'s socket handler expects. `accepted_statuscodes` is required on
 * EVERY monitor regardless of type — the server unconditionally runs
 * `monitor.accepted_statuscodes.every(...)` before it ever looks at `monitor.type` (see server.js's
 * `add` handler), so omitting it on a postgres/redis monitor throws before the type-specific fields
 * are even read. `timeout` is only load-bearing for the http type (used as `this.timeout * 1000` in
 * axios options — omitting it there sends `NaN` as the axios timeout instead of falling back to a
 * default); the frontend's own fallback is `~~(interval * 8) / 10`, reproduced literally below for
 * interval=60.
 */
export function toAddMonitorPayload(
  spec: KumaMonitorSpec,
  notificationIDList: Record<string, boolean>,
): Record<string, unknown> {
  const base = {
    name: spec.name,
    interval: 60,
    retryInterval: 60,
    resendInterval: 0,
    maxretries: 3,
    notificationIDList,
    accepted_statuscodes: ['200-299'],
    active: true,
  };

  if (spec.type === 'http') {
    return {
      ...base,
      type: 'http',
      url: spec.url,
      method: 'GET',
      timeout: 48, // ~~(60 * 8) / 10, matching EditMonitor.vue's own default derivation
      maxredirects: 10,
      ignoreTls: false,
      upsideDown: false,
    };
  }

  return {
    ...base,
    type: spec.type,
    databaseConnectionString: spec.databaseConnectionString,
    ignoreTls: false,
  };
}

export interface KumaMonitorListEntry {
  name?: string;
}

/** Monitor names already present (any user_id — this script only ever sees its own admin's
 *  monitors since Kuma scopes `getMonitorJSONList` to `socket.userID`), used to skip re-adding on
 *  a re-run rather than creating duplicates every install/update. */
export function namesAlreadyPresent(monitorList: Record<string, KumaMonitorListEntry>): Set<string> {
  return new Set(Object.values(monitorList).map((m) => m.name).filter((n): n is string => Boolean(n)));
}

export interface KumaNotificationListEntry {
  id: number;
  name?: string;
}

export function findNotificationIdByName(
  notifications: KumaNotificationListEntry[],
  name: string,
): number | null {
  return notifications.find((n) => n.name === name)?.id ?? null;
}
