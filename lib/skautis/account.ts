import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accountTable } from "@/db/schema";

export const getSkautisAccount = cache(async (userId: string) => db.query.accountTable.findFirst({
  where: and(eq(accountTable.userId, userId), eq(accountTable.providerId, "skautis")),
}));
