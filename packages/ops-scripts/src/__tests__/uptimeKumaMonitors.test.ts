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
    expect(postgres?.databaseConnectionString).toBe('postgresql://warmhawk:pg-secret@postgres:5432/warmhawk');
    expect(redis?.databaseConnectionString).toBe('redis://:redis-secret@redis:6379');
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
