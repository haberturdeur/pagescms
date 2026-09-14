import { NextRequest, NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/base-url";
import { callbackState, finishUrl, getSkautisConfig, verifySkautisToken } from "@/lib/skautis/protocol";
import { confirmLoginState, findLoginState, type LoginState } from "@/lib/skautis/state";

// SkautIS posts to the registered callback with ReturnUrl. Lax session cookies
// do not accompany this cross-site POST; finish on a same-site GET instead.
export async function POST(request: NextRequest) {
  const config = getSkautisConfig();
  if (!config) return new NextResponse(null, { status: 404 });
  try {
    if (request.headers.get("origin") !== config.origin) throw new Error("Invalid origin.");
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) throw new Error("Invalid content type.");
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing body.");
    let length = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 8192) { await reader.cancel(); throw new Error("Body too large."); }
      chunks.push(value);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const state = callbackState(request.nextUrl.searchParams.get("ReturnUrl") || form.get("ReturnUrl") || "", getBaseUrl());
    const record = await findLoginState(state);
    if (!record) throw new Error("Expired login.");
    const data = JSON.parse(record.value) as LoginState;
    if (data.providerId !== config.providerId || data.accountId) throw new Error("Invalid login state.");
    const accountId = await verifySkautisToken(config, form.get("skautIS_Token") || "");
    await confirmLoginState(state, record.value, { ...data, accountId });
    const response = NextResponse.redirect(finishUrl(getBaseUrl(), state), 303);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    return new NextResponse("SkautIS sign-in failed. Please return to the sign-in page and try again.", {
      status: 400, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }
}
