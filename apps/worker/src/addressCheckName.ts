/**
 * Which name the address check gives in EHLO, if any. ADDRESS_CHECK_HELO when set, exactly as
 * before. Otherwise the install's server name (MAIL_SERVER_NAME), but only once the API's check
 * has confirmed its reverse DNS (apps/api/src/lib/serverName.ts): a name whose reverse DNS
 * doesn't match gets every probe refused by the big providers, so every lead would come back
 * `unknown` while looking like the check was on.
 *
 * Read from the database (the API writes the result), at most once a minute.
 */
import { prisma } from '@warmhawk/db';
import { addressCheckConfig, type AddressCheckConfig } from './addressCheck';

const CACHE_MS = 60_000;

/** The saved check, as the API wrote it; a seam for tests. */
export type ServerNameRow = { serverName: string | null; serverNameStatus: string } | null;

async function readServerNameRow(): Promise<ServerNameRow> {
  return prisma.instanceSettings.findUnique({
    where: { id: 'default' },
    select: { serverName: true, serverNameStatus: true },
  });
}

let cached: { row: ServerNameRow; at: number } | null = null;

export async function currentAddressCheckConfig(
  env: NodeJS.ProcessEnv = process.env,
  readRow: () => Promise<ServerNameRow> = readServerNameRow,
): Promise<AddressCheckConfig | null> {
  const explicit = addressCheckConfig(env);
  if (explicit) return explicit;

  const name = env.MAIL_SERVER_NAME?.trim().toLowerCase().replace(/\.$/, '');
  if (!name) return null;
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    cached = { row: await readRow(), at: Date.now() };
  }
  const { row } = cached;
  if (row?.serverName !== name || row.serverNameStatus !== 'PASS') return null;
  return { helo: name, mailFrom: env.ADDRESS_CHECK_MAIL_FROM?.trim() || `check@${name}` };
}

/** Test seam: forget the in-process copy. */
export function resetAddressCheckNameCache(): void {
  cached = null;
}
