import { eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { skautisDirectorySessionTable } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { createHttpError } from "@/lib/api-error";
import { getSkautisAccount } from "./account";
import { getSkautisConfig, guidPattern } from "./config";

type DirectorySession = { token: string; accountId: string; unitId?: string };

export async function saveSkautisDirectorySession(sessionId: string, value: DirectorySession, expiresAt: number) {
  await db.delete(skautisDirectorySessionTable).where(lte(skautisDirectorySessionTable.expiresAt, new Date()));
  const { ciphertext, iv } = await encrypt(JSON.stringify(value));
  await db.insert(skautisDirectorySessionTable).values({ sessionId, ciphertext, iv, expiresAt: new Date(expiresAt) })
    .onConflictDoUpdate({ target: skautisDirectorySessionTable.sessionId, set: { ciphertext, iv, expiresAt: new Date(expiresAt) } });
}

export async function getSkautisDirectorySession(sessionId: string, userId: string): Promise<DirectorySession> {
  const config = getSkautisConfig();
  const row = await db.query.skautisDirectorySessionTable.findFirst({ where: eq(skautisDirectorySessionTable.sessionId, sessionId) });
  if (!config || !row || row.expiresAt.getTime() <= Date.now()) {
    if (row) await db.delete(skautisDirectorySessionTable).where(eq(skautisDirectorySessionTable.sessionId, sessionId));
    throw createHttpError("Sign out and sign in with skautIS again to search the unit directory.", 401);
  }
  let value: DirectorySession;
  try {
    value = JSON.parse(await decrypt(row.ciphertext, row.iv));
    if (!value || typeof value.token !== "string" || typeof value.accountId !== "string") throw new Error("Invalid session payload.");
  }
  catch { throw createHttpError("Your skautIS directory session is unavailable. Please sign in again.", 401); }
  const account = await getSkautisAccount(userId);
  if (!guidPattern.test(value.token) || value.accountId !== account?.accountId || !value.accountId.startsWith(`${config.environment}:`)) {
    throw createHttpError("Your skautIS directory session does not match this account.", 401);
  }
  return value;
}
