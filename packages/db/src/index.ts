/**
 * Shared Prisma client singleton — imported as `@warmhawk/db` by both apps/api and apps/worker.
 * A single `prisma` export avoids creating a new PrismaClient per import in dev/hot-reload and
 * per test file.
 */
import { PrismaClient } from '../generated/client';

declare global {
  var __warmhawkPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__warmhawkPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__warmhawkPrisma = prisma;
}

export * from '../generated/client';
