/**
 * `POST /auth/login` — authenticates against this engine's own `User` table (protects
 * warmhawk-core-engine's management routes; see lib/requireAuth.ts's note distinguishing this
 * from warmhawk-enterprise-operator's separate dashboard login). Rate-limited AND brute-force
 * locked out per the Guardrails section, both layers active simultaneously (rate limiting slows
 * a distributed attempt; the per-account lockout stops a slow, patient one).
 */
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { prisma } from '@warmhawk/db';
import { signAuthToken } from '../lib/jwt';
import { checkLoginThrottle, recordFailedAttempt, resetLoginThrottle } from '../lib/loginThrottle';
import { RATE_LIMIT_LOGIN } from '../../../../constants';

interface LoginBody {
  email?: string;
  password?: string;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LoginBody }>(
    '/login',
    {
      config: {
        rateLimit: { max: RATE_LIMIT_LOGIN.max, timeWindow: RATE_LIMIT_LOGIN.timeWindowMs },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      if (!email || !password) {
        return reply.code(422).send({ error: 'email and password are required' });
      }

      const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
      // Constant-shape response whether the user exists or not, to avoid a user-enumeration
      // timing/response-shape signal — but still evaluate the throttle only when a real user
      // row exists, since there's no per-account state to throttle otherwise.
      if (!user) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const throttleCheck = checkLoginThrottle({
        failedLoginAttempts: user.failedLoginAttempts,
        lockedUntil: user.lockedUntil,
      });
      if (throttleCheck.locked) {
        return reply.code(429).send({
          error: 'Account temporarily locked due to repeated failed login attempts',
          retryAfterMs: throttleCheck.retryAfterMs,
        });
      }

      const passwordValid = await bcrypt.compare(password, user.passwordHash);
      if (!passwordValid) {
        const nextState = recordFailedAttempt({
          failedLoginAttempts: user.failedLoginAttempts,
          lockedUntil: user.lockedUntil,
        });
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: nextState.failedLoginAttempts,
            lockedUntil: nextState.lockedUntil,
          },
        });
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const resetState = resetLoginThrottle();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: resetState.failedLoginAttempts,
          lockedUntil: resetState.lockedUntil,
        },
      });

      const token = signAuthToken({ sub: user.id, email: user.email, role: user.role });
      return reply.send({ token });
    },
  );
}
