import { XMLParser, XMLValidator } from "fast-xml-parser";

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const statePattern = /^[0-9a-f]{64}$/;
export type SkautisConfig = { appId: string; origin: string; providerId: string };

export function getSkautisConfig(env = process.env): SkautisConfig | null {
  const appId = env.SKAUTIS_APP_ID?.trim();
  if (!appId) return null;
  if (!guid.test(appId)) throw new Error("SKAUTIS_APP_ID must be a UUID.");
  const environment = env.SKAUTIS_ENVIRONMENT || "test";
  if (environment !== "test" && environment !== "production") {
    throw new Error("SKAUTIS_ENVIRONMENT must be test or production.");
  }
  return {
    appId,
    origin: environment === "test" ? "https://test-is.skaut.cz" : "https://is.skaut.cz",
    providerId: `skautis-${environment}`,
  };
}

export function finishUrl(baseUrl: string, state: string) {
  if (!statePattern.test(state)) throw new Error("Invalid login state.");
  const url = new URL("/api/auth/skautis/finish", baseUrl);
  url.searchParams.set("state", state);
  return url;
}

export function callbackState(returnUrl: string, baseUrl: string) {
  const url = new URL(returnUrl);
  const state = url.searchParams.get("state") || "";
  if (!statePattern.test(state) || url.href !== finishUrl(baseUrl, state).href) {
    throw new Error("Invalid return URL.");
  }
  return state;
}

export function loginUrl(config: SkautisConfig, returnUrl: URL) {
  const url = new URL("/Login/", config.origin);
  url.searchParams.set("appid", config.appId);
  url.searchParams.set("ReturnUrl", returnUrl.href);
  return url.href;
}

export function userDetailEnvelope(token: string) {
  if (!guid.test(token)) throw new Error("Invalid SkautIS token.");
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<soap:Body><UserDetail xmlns="https://is.skaut.cz/"><userDetailInput>
<ID_Login>${token}</ID_Login><ID xsi:nil="true" />
</userDetailInput></UserDetail></soap:Body></soap:Envelope>`;
}

export function parseUserDetail(xml: string): string {
  if (xml.length > 65536 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error("Invalid SkautIS response.");
  }
  const data = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(xml);
  const body = data?.Envelope?.Body;
  const user = body?.UserDetailResponse?.UserDetailResult;
  if (body?.Fault || !user || !/^[1-9][0-9]*$/.test(user.ID)
    || !["true", "1"].includes(user.IsActive) || !["true", "1"].includes(user.IsEnabled)) {
    throw new Error("SkautIS did not confirm an active account.");
  }
  // Never infer identity or permissions from posted role/unit/email fields.
  return user.ID;
}

export async function verifySkautisToken(config: SkautisConfig, token: string) {
  const response = await fetch(`${config.origin}/JunakWebservice/UserManagement.asmx`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"https://is.skaut.cz/UserDetail"' },
    body: userDetailEnvelope(token),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("SkautIS verification failed.");
  // Bound the response before parsing, including responses without Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty SkautIS response.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 65536) { await reader.cancel(); throw new Error("SkautIS response too large."); }
    chunks.push(value);
  }
  return parseUserDetail(Buffer.concat(chunks).toString("utf8"));
}
