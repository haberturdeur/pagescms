import { randomUUID } from "node:crypto";
import { and, eq, gt, like, lte } from "drizzle-orm";
import { db } from "@/db";
import { accountTable, verificationTable } from "@/db/schema";
import { skautisFlowSeconds } from "./config";

export type SkautisFlow = { redirect: string; userId: string | null; sessionId: string | null };

export async function saveSkautisFlow(state: string, flow: SkautisFlow) {
  await db.delete(verificationTable).where(and(
    like(verificationTable.identifier, "skautis:%"), lte(verificationTable.expiresAt, new Date()),
  ));
  await db.insert(verificationTable).values({
    id: randomUUID(), identifier: `skautis:${state}`, value: JSON.stringify(flow),
    expiresAt: new Date(Date.now() + skautisFlowSeconds * 1000),
  });
}

export async function consumeSkautisFlow(state: string): Promise<SkautisFlow | null> {
  // DELETE RETURNING makes completion single-use even across concurrent requests.
  const [row] = await db.delete(verificationTable).where(and(
    eq(verificationTable.identifier, `skautis:${state}`), gt(verificationTable.expiresAt, new Date()),
  )).returning();
  return row ? JSON.parse(row.value) : null;
}

export async function linkSkautisAccount(accountId: string, userId: string) {
  await db.insert(accountTable).values({ id: randomUUID(), providerId: "skautis", accountId, userId })
    .onConflictDoNothing();
  const account = await db.query.accountTable.findFirst({ where: and(
    eq(accountTable.providerId, "skautis"), eq(accountTable.accountId, accountId),
  ) });
  if (!account || account.userId !== userId) throw new Error("skautIS identity is already connected or this account has another identity.");
  return account;
}
