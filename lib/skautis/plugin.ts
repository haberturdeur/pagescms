import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { db } from "@/db";
import { accountTable } from "@/db/schema";
import { getBaseUrl } from "@/lib/base-url";
import { getSkautisConfig, finishUrl, loginUrl, statePattern } from "./protocol";
import { browserCookie, browserHash, consumeLoginState, findLoginState, newLoginState, type LoginState } from "./state";

const requireConfig = () => {
  const config = getSkautisConfig();
  if (!config) throw new APIError("NOT_FOUND", { message: "SkautIS sign-in is not enabled." });
  return config;
};

export const skautisAuth = () => ({
  id: "skautis",
  rateLimit: [{ pathMatcher: (path: string) => path.startsWith("/skautis/"), window: 60, max: 10 }],
  endpoints: {
    startSkautis: createAuthEndpoint("/skautis/start", {
      method: "POST", body: z.object({ mode: z.enum(["login", "link"]) }),
    }, async (ctx) => {
      const config = requireConfig();
      const current = await getSessionFromCtx(ctx);
      if (ctx.body.mode === "link" && (!current?.user.emailVerified
        || Date.now() - new Date(current.session.createdAt).getTime() > 15 * 60 * 1000)) {
        throw new APIError("FORBIDDEN", { message: "Sign out and sign in again before connecting SkautIS." });
      }
      const browser = randomBytes(32).toString("hex");
      const state = await newLoginState({
        browserHash: browserHash(browser), providerId: config.providerId, mode: ctx.body.mode,
        ...(ctx.body.mode === "link" ? { userId: current!.user.id, sessionId: current!.session.id } : {}),
      });
      ctx.setCookie(browserCookie, browser, {
        httpOnly: true, secure: new URL(getBaseUrl()).protocol === "https:",
        sameSite: "lax", path: "/", maxAge: 600,
      });
      return ctx.json({ url: loginUrl(config, finishUrl(getBaseUrl(), state)) });
    }),
    finishSkautis: createAuthEndpoint("/skautis/finish", {
      method: "GET", query: z.object({ state: z.string().regex(statePattern) }),
    }, async (ctx) => {
      const config = requireConfig();
      let destination = "/";
      try {
        const record = await findLoginState(ctx.query.state);
        const browser = ctx.getCookie(browserCookie);
        if (!record || !browser) throw new Error("Missing login state.");
        const data = JSON.parse(record.value) as LoginState;
        if (data.browserHash !== browserHash(browser) || data.providerId !== config.providerId || !data.accountId) {
          throw new Error("Invalid login state.");
        }
        const current = await getSessionFromCtx(ctx);
        if (data.mode === "link" && (!current?.user.emailVerified
          || current.user.id !== data.userId || current.session.id !== data.sessionId)) {
          throw new Error("Account linking session changed.");
        }
        await consumeLoginState(ctx.query.state, record.value);
        if (data.mode === "link") {
          await db.transaction(async (tx) => {
            // Serialize link creation; the upstream account schema has no provider/account unique constraint.
            await tx.execute(sql`select pg_advisory_xact_lock(731254891)`);
            const identities = await tx.select().from(accountTable).where(eq(accountTable.providerId, config.providerId));
            if (identities.some(account => (account.accountId === data.accountId && account.userId !== data.userId)
              || (account.userId === data.userId && account.accountId !== data.accountId))) {
              throw new Error("Account already linked.");
            }
            if (!identities.some(account => account.accountId === data.accountId)) {
              await tx.insert(accountTable).values({
                id: randomUUID(), providerId: config.providerId, accountId: data.accountId!, userId: data.userId!,
              });
            }
          });
          destination = "/settings?skautis=connected";
        } else {
          const account = await db.query.accountTable.findFirst({ where: and(
            eq(accountTable.providerId, config.providerId), eq(accountTable.accountId, data.accountId),
          ) });
          if (!account) {
            destination = "/sign-in?error=" + encodeURIComponent("Sign in with email first, then connect SkautIS in Settings.");
          } else {
            const user = await ctx.context.internalAdapter.findUserById(account.userId);
            if (!user || !user.emailVerified) throw new Error("Verified CMS account required.");
            const session = await ctx.context.internalAdapter.createSession(user.id);
            if (!session) throw new Error("Could not create session.");
            await setSessionCookie(ctx, { session, user });
          }
        }
      } catch {
        // Never expose or log SkautIS tokens or SOAP responses.
        destination = "/sign-in?error=" + encodeURIComponent("SkautIS sign-in could not be completed. Try again or use email.");
      }
      ctx.setCookie(browserCookie, "", { httpOnly: true, secure: new URL(getBaseUrl()).protocol === "https:", sameSite: "lax", path: "/", maxAge: 0 });
      ctx.setHeader("Cache-Control", "no-store");
      ctx.setHeader("Referrer-Policy", "no-referrer");
      throw ctx.redirect(destination);
    }),
    disconnectSkautis: createAuthEndpoint("/skautis/disconnect", { method: "POST" }, async (ctx) => {
      const config = requireConfig();
      const current = await getSessionFromCtx(ctx);
      if (!current?.user.emailVerified) throw new APIError("UNAUTHORIZED");
      await db.delete(accountTable).where(and(eq(accountTable.providerId, config.providerId), eq(accountTable.userId, current.user.id)));
      return ctx.json({ success: true });
    }),
  },
});
