import { describe, it, expect } from 'vitest';
import {
  checkLoginThrottle,
  recordFailedAttempt,
  resetLoginThrottle,
} from '../../lib/loginThrottle';

describe('login brute-force throttle', () => {
  it('is not locked with zero failed attempts', () => {
    const check = checkLoginThrottle({ failedLoginAttempts: 0, lockedUntil: null });
    expect(check.locked).toBe(false);
  });

  it('locks the account after reaching the max failed attempts (5)', () => {
    let state = { failedLoginAttempts: 0, lockedUntil: null as Date | null };
    const now = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 4; i++) {
      state = recordFailedAttempt(state, now);
      expect(state.lockedUntil).toBeNull();
    }
    state = recordFailedAttempt(state, now); // 5th failure
    expect(state.failedLoginAttempts).toBe(5);
    expect(state.lockedUntil).not.toBeNull();
  });

  it('reports locked=true with a retryAfterMs while within the lockout window', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const lockedUntil = new Date(now.getTime() + 10 * 60 * 1000);
    const check = checkLoginThrottle({ failedLoginAttempts: 5, lockedUntil }, now);
    expect(check.locked).toBe(true);
    expect(check.retryAfterMs).toBeGreaterThan(0);
  });

  it('reports locked=false once the lockout window has passed', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const lockedUntil = new Date(now.getTime() - 1000); // already expired
    const check = checkLoginThrottle({ failedLoginAttempts: 5, lockedUntil }, now);
    expect(check.locked).toBe(false);
  });

  it('resetLoginThrottle clears both fields after a successful login', () => {
    expect(resetLoginThrottle()).toEqual({ failedLoginAttempts: 0, lockedUntil: null });
  });
});
