/**
 * Unit tests for `lib/alertWebhook.ts#postDomainChangeAlert` — the Tier-2-only domain-change
 * webhook. `fetchImpl` is injected directly (see that file's header comment on why: no existing
 * fetch-DI convention in this repo to follow, so this is the simple optional-param fallback)
 * rather than mocking `global.fetch`, so these tests never touch the real network either way.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { postDomainChangeAlert } from '../../lib/alertWebhook';

const CHANGE = { domain: 'example.com', field: 'spfStatus', before: 'PASS', after: 'FAIL' };

describe('postDomainChangeAlert', () => {
  const originalUrl = process.env.TIER2_ALERT_WEBHOOK_URL;
  const originalFormat = process.env.TIER2_ALERT_WEBHOOK_FORMAT;

  afterEach(() => {
    process.env.TIER2_ALERT_WEBHOOK_URL = originalUrl;
    process.env.TIER2_ALERT_WEBHOOK_FORMAT = originalFormat;
  });

  it('is a no-op — never calls fetch — when TIER2_ALERT_WEBHOOK_URL is unset', async () => {
    delete process.env.TIER2_ALERT_WEBHOOK_URL;
    const fetchImpl = vi.fn();

    await postDomainChangeAlert(CHANGE, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the generic JSON body shape by default (format unset)', async () => {
    process.env.TIER2_ALERT_WEBHOOK_URL = 'https://hooks.example.com/generic';
    delete process.env.TIER2_ALERT_WEBHOOK_FORMAT;
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);

    await postDomainChangeAlert(CHANGE, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/generic');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      domain: 'example.com',
      field: 'spfStatus',
      before: 'PASS',
      after: 'FAIL',
    });
  });

  it('posts the generic JSON body shape when format is explicitly "generic"', async () => {
    process.env.TIER2_ALERT_WEBHOOK_URL = 'https://hooks.example.com/generic';
    process.env.TIER2_ALERT_WEBHOOK_FORMAT = 'generic';
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);

    await postDomainChangeAlert(CHANGE, fetchImpl);

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      domain: 'example.com',
      field: 'spfStatus',
      before: 'PASS',
      after: 'FAIL',
    });
  });

  it('posts a Slack-shaped { text } body when format is "slack"', async () => {
    process.env.TIER2_ALERT_WEBHOOK_URL = 'https://hooks.slack.com/services/xxx';
    process.env.TIER2_ALERT_WEBHOOK_FORMAT = 'slack';
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);

    await postDomainChangeAlert(CHANGE, fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/xxx');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      text: '⚠️ example.com: spfStatus changed from PASS to FAIL',
    });
  });

  it('defaults fetchImpl to the global fetch when not passed', async () => {
    process.env.TIER2_ALERT_WEBHOOK_URL = 'https://hooks.example.com/generic';
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);

    try {
      await postDomainChangeAlert(CHANGE);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
