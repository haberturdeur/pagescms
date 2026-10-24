import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { decrypt } from "@/lib/crypto";
import { getBaseUrl } from "@/lib/base-url";
import { getSkautisConfig, skautisFlowSeconds, skautisHandoffCookie, skautisRedirect, skautisStateCookie } from "./config";
import { verifySkautisLogin } from "./client";
import { consumeSkautisFlow, linkSkautisAccount, saveSkautisFlow, type SkautisFlow } from "./store";

export const skautis = (): BetterAuthPlugin => ({
  id: "skautis",
  endpoints: {
    startSkautis: createAuthEndpoint("/sign-in/skautis", {
      method: "POST", requireHeaders: true,
      body: z.object({ redirect: z.string().max(2048).optional(), link: z.boolean().optional() }),
    }, async ctx => {
      const config = getSkautisConfig();
      if (!config) throw new APIError("NOT_FOUND", { message: "skautIS is disabled." });
      if (ctx.headers?.get("origin") !== new URL(getBaseUrl()).origin) {
        throw new APIError("FORBIDDEN", { message: "Invalid origin." });
      }
      const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
      if (ctx.body.link && !session) throw new APIError("UNAUTHORIZED", { message: "Sign in before connecting skautIS." });
      if (!ctx.body.link && session) throw new APIError("BAD_REQUEST", { message: "Use Settings to connect skautIS." });
      const state = randomBytes(32).toString("hex");
      await saveSkautisFlow(state, {
        redirect: ctx.body.link ? "/settings" : skautisRedirect(ctx.body.redirect),
        userId: ctx.body.link ? session!.user.id : null,
        sessionId: ctx.body.link ? session!.session.id : null,
      });
      await ctx.setSignedCookie(skautisStateCookie, state, ctx.context.secret, {
        httpOnly: true, secure: config.secure, sameSite: "lax", path: "/", maxAge: skautisFlowSeconds,
      });
      const callback = config.callbackUrl;
      callback.searchParams.set("state", state);
      const url = new URL("/Login/", config.origin);
      url.searchParams.set("appid", config.appId);
      url.searchParams.set("ReturnUrl", callback.toString());
      return ctx.json({ url: url.toString() });
    }),
    completeSkautis: createAuthEndpoint("/skautis/complete", { method: "GET", requireHeaders: true }, async ctx => {
      let flow: SkautisFlow | null = null;
      const fail = (code: string): never => { throw ctx.redirect(new URL(`${flow?.userId ? "/settings" : "/sign-in"}?error=${code}`, getBaseUrl()).toString()); };
      const config = getSkautisConfig();
      if (!config) return fail("skautis_disabled");
      ctx.setHeader("Cache-Control", "no-store");
      ctx.setHeader("Referrer-Policy", "no-referrer");
      const options = { path: "/", httpOnly: true, secure: config.secure, sameSite: "lax" as const, maxAge: 0 };
      const cookie = ctx.getCookie(skautisHandoffCookie);
      const state = await ctx.getSignedCookie(skautisStateCookie, ctx.context.secret);
      ctx.setCookie(skautisHandoffCookie, "", options);
      ctx.setCookie(skautisStateCookie, "", options);
      let identity;
      try {
        if (!cookie || !state || !/^[a-f0-9]{64}$/.test(state)) throw new Error("Missing state.");
        const encrypted = JSON.parse(Buffer.from(cookie, "base64url").toString("utf8"));
        const handoff = JSON.parse(await decrypt(encrypted.ciphertext, encrypted.iv));
        if (handoff.state !== state || typeof handoff.token !== "string" || typeof handoff.expiresAt !== "number" || handoff.expiresAt <= Date.now()) throw new Error("Invalid state.");
        flow = await consumeSkautisFlow(state);
        if (!flow) throw new Error("Expired or used state.");
        identity = await verifySkautisLogin(handoff.token);
      } catch {
        // Do not log upstream tokens, SOAP faults or callback payloads.
        return fail("skautis_failed");
      }
      const accountId = `${identity.environment}:${identity.userId}`;
      if (flow.userId) {
        const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
        if (!session || session.user.id !== flow.userId || session.session.id !== flow.sessionId) return fail("skautis_session_changed");
        try { await linkSkautisAccount(accountId, flow.userId); }
        catch { return fail("skautis_already_connected"); }
        throw ctx.redirect(new URL("/settings?skautis=connected", getBaseUrl()).toString());
      }
      const account = await ctx.context.internalAdapter.findAccountByProviderId(accountId, "skautis");
      if (!account) return fail("skautis_not_connected");
      const user = await ctx.context.internalAdapter.findUserById(account.userId);
      if (!user) return fail("skautis_failed");
      const session = await ctx.context.internalAdapter.createSession(user.id);
      if (!session) return fail("skautis_failed");
      await setSessionCookie(ctx, { session, user });
      throw ctx.redirect(new URL(skautisRedirect(flow.redirect), getBaseUrl()).toString());
    }),
  },
  rateLimit: [{ pathMatcher: path => path === "/sign-in/skautis" || path === "/skautis/complete", window: 60, max: 10 }],
});
