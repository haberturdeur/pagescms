import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt, like } from "drizzle-orm";
import { db } from "@/db";
import { verificationTable } from "@/db/schema";
import { statePattern } from "./protocol";

export const browserCookie = "pagescms.skautis-browser";
export const browserHash = (value: string) => createHash("sha256").update(value).digest("hex");
export type LoginState = {
  browserHash: string;
  providerId: string;
  mode: "login" | "link";
  userId?: string;
  sessionId?: string;
  accountId?: string;
};
const identifier = (state: string) => {
  if (!statePattern.test(state)) throw new Error("Invalid state.");
  return `skautis:${state}`;
};

export async function newLoginState(data: LoginState) {
  const state = randomBytes(32).toString("hex");
  await db.delete(verificationTable).where(and(
    lt(verificationTable.expiresAt, new Date()),
    // Only clean this integration's records.
    like(verificationTable.identifier, "skautis:%"),
  ));
  await db.insert(verificationTable).values({
    id: identifier(state), identifier: identifier(state), value: JSON.stringify(data),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return state;
}

export async function findLoginState(state: string) {
  return db.query.verificationTable.findFirst({ where: and(
    eq(verificationTable.id, identifier(state)), gt(verificationTable.expiresAt, new Date()),
  ) });
}

export async function confirmLoginState(state: string, originalValue: string, data: LoginState) {
  const updated = await db.update(verificationTable).set({ value: JSON.stringify(data) }).where(and(
    eq(verificationTable.id, identifier(state)), eq(verificationTable.value, originalValue),
    gt(verificationTable.expiresAt, new Date()),
  )).returning({ id: verificationTable.id });
  if (!updated.length) throw new Error("Login expired or already processed.");
}

export async function consumeLoginState(state: string, originalValue: string) {
  const deleted = await db.delete(verificationTable).where(and(
    eq(verificationTable.id, identifier(state)), eq(verificationTable.value, originalValue),
    gt(verificationTable.expiresAt, new Date()),
  )).returning({ id: verificationTable.id });
  if (!deleted.length) throw new Error("Login expired or already used.");
}
