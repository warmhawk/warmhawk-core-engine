import { describe, expect, it } from 'vitest';
import {
  buildMonitorSpecs,
  findNotificationIdByName,
  namesAlreadyPresent,
  toAddMonitorPayload,
} from '../uptimeKumaMonitors';

const ENV = { postgresPassword: 'pg-secret', redisPassword: 'redis-secret' };

describe('buildMonitorSpecs', () => {
  it('covers every internal-network service exactly once', () => {
    const specs = buildMonitorSpecs(ENV);
    const names = specs.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'WarmHawk — nginx (edge)',
      'WarmHawk — api',
      'WarmHawk — n8n',
      'WarmHawk — postgres',
      'WarmHawk — redis',
    ]);
  });

  it('embeds the real postgres/redis passwords into native db connection strings', () => {
    const specs = buildMonitorSpecs(ENV);
    const postgres = specs.find((s) => s.name.includes('postgres'));
    const redis = specs.find((s) => s.name.includes('redis'));
    expect(postgres?.databaseConnectionString).toBe(
      'postgresql://warmhawk:pg-secret@warmhawk-core-engine-postgres:5432/warmhawk',
    );
    expect(redis?.databaseConnectionString).toBe('redis://:redis-secret@warmhawk-core-engine-redis:6379');
  });

  it('percent-encodes a redisPassword containing "/" so the redis connection string stays a valid URL (bug fix, 2026-09-04)', () => {
    // Regression test for the same REDIS_PASSWORD-can-contain-"/" bug fixed in
    // apps/worker/src/queue.ts's buildRedisUrl — this file's own redis: connection string is
    // consumed by uptime-kuma's server-side URL parser, so it needs the identical treatment.
    const specs = buildMonitorSpecs({ postgresPassword: 'pg-secret', redisPassword: 'ab/cd@ef' });
    const redis = specs.find((s) => s.name.includes('redis'));
    expect(redis?.databaseConnectionString).toBe('redis://:ab%2Fcd%40ef@warmhawk-core-engine-redis:6379');
    expect(() => new URL(redis!.databaseConnectionString!)).not.toThrow();
    expect(decodeURIComponent(new URL(redis!.databaseConnectionString!).password)).toBe('ab/cd@ef');
  });

  it('targets container names, never bare Compose service names (bug fix, 2026-09-06)', () => {
    // Regression test for the alert-flapping bug: uptime-kuma is attached to the SHARED
    // warmhawk_edge network, where a bare `nginx`/`api`/`postgres` alias can belong to another
    // Compose project's container too. Docker DNS returns all of them round-robin, so a bare-name
    // monitor health-checks a random stranger. Container names are unique per box.
    const hosts = buildMonitorSpecs(ENV).map((s) =>
      s.type === 'http' ? new URL(s.url!).hostname : new URL(s.databaseConnectionString!).hostname,
    );
    expect(hosts).toEqual([
      'warmhawk-core-engine-nginx',
      'warmhawk-core-engine-api',
      'warmhawk-core-engine-n8n',
      'warmhawk-core-engine-postgres',
      'warmhawk-core-engine-redis',
    ]);
    for (const host of hosts) {
      expect(host).toMatch(/^warmhawk-core-engine-/);
    }
  });

  it('honours COMPOSE_PROJECT_NAME so two installs on one box stay distinct', () => {
    // container_name is `${COMPOSE_PROJECT_NAME:-warmhawk-core-engine}-<service>`, so a second
    // install under a different project name must be monitored at ITS own containers, not the
    // first install's.
    const specs = buildMonitorSpecs({ ...ENV, containerPrefix: 'wh-tenant-b' });
    expect(new URL(specs[0].url!).hostname).toBe('wh-tenant-b-nginx');
    expect(new URL(specs[3].databaseConnectionString!).hostname).toBe('wh-tenant-b-postgres');
  });

  it('falls back to the Compose default prefix when COMPOSE_PROJECT_NAME is unset or blank', () => {
    for (const containerPrefix of [undefined, '', '   ']) {
      const specs = buildMonitorSpecs({ ...ENV, containerPrefix });
      expect(new URL(specs[0].url!).hostname).toBe('warmhawk-core-engine-nginx');
    }
  });
});

describe('toAddMonitorPayload', () => {
  it('always includes accepted_statuscodes, regardless of type', () => {
    const specs = buildMonitorSpecs(ENV);
    for (const spec of specs) {
      const payload = toAddMonitorPayload(spec, {});
      expect(Array.isArray(payload.accepted_statuscodes)).toBe(true);
      expect((payload.accepted_statuscodes as string[]).every((c) => typeof c === 'string')).toBe(true);
    }
  });

  it('sets an explicit numeric timeout on http monitors (never NaN)', () => {
    const payload = toAddMonitorPayload({ name: 'x', type: 'http', url: 'http://x/health' }, {});
    expect(payload.timeout).toBe(48);
    expect(Number.isNaN(payload.timeout)).toBe(false);
  });

  it('omits url/timeout on db-type monitors and carries the connection string instead', () => {
    const payload = toAddMonitorPayload(
      { name: 'x', type: 'postgres', databaseConnectionString: 'postgresql://a:b@c:5432/d' },
      {},
    );
    expect(payload.url).toBeUndefined();
    expect(payload.timeout).toBeUndefined();
    expect(payload.databaseConnectionString).toBe('postgresql://a:b@c:5432/d');
  });

  it('attaches the given notificationIDList map as-is', () => {
    const payload = toAddMonitorPayload({ name: 'x', type: 'http', url: 'http://x/health' }, { '3': true });
    expect(payload.notificationIDList).toEqual({ '3': true });
  });
});

describe('namesAlreadyPresent', () => {
  it('extracts monitor names from the keyed-by-id map Kuma pushes', () => {
    const names = namesAlreadyPresent({
      '1': { name: 'WarmHawk — api' },
      '2': { name: 'Some customer monitor' },
    });
    expect(names.has('WarmHawk — api')).toBe(true);
    expect(names.has('Some customer monitor')).toBe(true);
    expect(names.size).toBe(2);
  });

  it('ignores entries with no name rather than throwing', () => {
    const names = namesAlreadyPresent({ '1': {} });
    expect(names.size).toBe(0);
  });
});

describe('findNotificationIdByName', () => {
  it('finds an existing notification by exact name match', () => {
    const id = findNotificationIdByName(
      [
        { id: 5, name: 'Other' },
        { id: 9, name: 'WarmHawk alerts' },
      ],
      'WarmHawk alerts',
    );
    expect(id).toBe(9);
  });

  it('returns null when no notification has that name (first-run case)', () => {
    expect(findNotificationIdByName([], 'WarmHawk alerts')).toBeNull();
  });
});
