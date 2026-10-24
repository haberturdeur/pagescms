import { NextResponse } from "next/server";
import { encrypt } from "@/lib/crypto";
import { getBaseUrl } from "@/lib/base-url";
import { getSkautisConfig, guidPattern, skautisHandoffCookie } from "@/lib/skautis/config";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const config = getSkautisConfig();
  if (!config) return new Response(null, { status: 404 });
  // A top-level cross-site POST does not carry our SameSite=Lax state cookie.
  // Relay an encrypted, short-lived payload to a GET, where it can be checked.
  const state = new URL(request.url).searchParams.get("state");
  if (!state || !/^[a-f0-9]{64}$/.test(state)
    || !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return new Response(null, { status: 400 });
  }
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) return new Response(null, { status: 413 });
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const token = fields.get("skautIS_Token");
  if (!token || !guidPattern.test(token) || fields.getAll("skautIS_Token").length !== 1) return new Response(null, { status: 400 });
  const encrypted = await encrypt(JSON.stringify({ state, token, expiresAt: Date.now() + 60000 }));
  const response = NextResponse.redirect(new URL("/api/auth/skautis/complete", getBaseUrl()), 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(skautisHandoffCookie, Buffer.from(JSON.stringify(encrypted)).toString("base64url"), {
    httpOnly: true, secure: config.secure, sameSite: "lax", path: "/", maxAge: 60,
  });
  return response;
}
