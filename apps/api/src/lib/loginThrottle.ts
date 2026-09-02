/**
 * Login brute-force protection — Guardrails / Account security: "Dashboard login brute-force
 * protection: rate-limit and lock out POST /auth/login after repeated failures." This engine's
 * own `/auth/login` protects its management API (see lib/requireAuth.ts's note on API-vs-
 * dashboard auth); the licensed dashboard's own login endpoint implements
 * the equivalent check against its own separate Postgres/session model.
 *
 * Pure evaluation logic factored out for unit testing; the route (routes/auth.ts) is responsible
 * for reading/writing `User.failedLoginAttempts`/`lockedUntil`.
 */
import { LOGIN_MAX_FAILED_ATTEMPTS, LOGIN_LOCKOUT_DURATION_MS } from '../../../../constants';

export interface LoginThrottleState {
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

export interface LoginThrottleCheck {
  locked: boolean;
  retryAfterMs?: number;
}

/** Checks whether a login attempt should be blocked BEFORE even verifying the password, given
 *  the account's current throttle state. */
export function checkLoginThrottle(
  state: LoginThrottleState,
  now: Date = new Date(),
): LoginThrottleCheck {
  if (state.lockedUntil && state.lockedUntil.getTime() > now.getTime()) {
    return { locked: true, retryAfterMs: state.lockedUntil.getTime() - now.getTime() };
  }
  return { locked: false };
}

/** Computes the next throttle state after a FAILED login attempt — locks the account once
 *  `LOGIN_MAX_FAILED_ATTEMPTS` is reached, for `LOGIN_LOCKOUT_DURATION_MS`. */
export function recordFailedAttempt(
  state: LoginThrottleState,
  now: Date = new Date(),
): LoginThrottleState {
  const failedLoginAttempts = state.failedLoginAttempts + 1;
  const lockedUntil =
    failedLoginAttempts >= LOGIN_MAX_FAILED_ATTEMPTS
      ? new Date(now.getTime() + LOGIN_LOCKOUT_DURATION_MS)
      : state.lockedUntil;
  return { failedLoginAttempts, lockedUntil };
}

/** Resets throttle state after a SUCCESSFUL login. */
export function resetLoginThrottle(): LoginThrottleState {
  return { failedLoginAttempts: 0, lockedUntil: null };
}
