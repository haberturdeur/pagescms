import { XMLParser, XMLValidator } from "fast-xml-parser";
import { createHttpError } from "@/lib/api-error";
import { getSkautisConfig, guidPattern } from "./config";

type SoapMethod = "LoginDetail" | "UserRoleAll" | "UserAll";
type SoapValue = string | number | boolean | null;
export type SoapRecord = Record<string, unknown>;

export function parseSkautisResult(xml: string, method: SoapMethod, limit: number): SoapRecord {
  if (Buffer.byteLength(xml) > limit || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw createHttpError("Invalid skautIS response.", 502);
  }
  const parsed = new XMLParser({ removeNSPrefix: true, parseTagValue: false, ignoreAttributes: false }).parse(xml);
  const body = parsed?.Envelope?.Body;
  if (body?.Fault) {
    const fault = typeof body.Fault.faultstring === "string" ? body.Fault.faultstring : "";
    if (/neplatn.{0,8}login|přihlášen|expired/i.test(fault)) throw createHttpError("Your skautIS session has expired. Sign in again to search.", 401);
    if (/oprávn|přístup odepřen/i.test(fault)) throw createHttpError("skautIS does not allow this directory search for your account or this application.", 403);
    throw createHttpError("skautIS could not complete the directory request.", 502);
  }
  const response = body?.[`${method}Response`];
  if (!response || !Object.hasOwn(response, `${method}Result`)) throw createHttpError("Invalid skautIS response.", 502);
  return response[`${method}Result`] || {};
}

const xmlText = (value: SoapValue) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export async function callSkautis(method: SoapMethod, token: string, fields: Record<string, SoapValue> = {}, limit = 65536) {
  if (!guidPattern.test(token)) throw createHttpError("Invalid skautIS session.", 401);
  const config = getSkautisConfig();
  if (!config) throw createHttpError("skautIS is disabled.", 503);
  const input = Object.entries({ ID_Login: token, ...fields }).map(([name, value]) => value === null
    ? `<${name} xsi:nil="true"/>` : `<${name}>${xmlText(value)}</${name}>`).join("");
  const wrapper = method[0].toLowerCase() + method.slice(1) + "Input";
  let response: Response;
  try {
    response = await fetch(`${config.origin}/JunakWebservice/UserManagement.asmx`, {
      method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"https://is.skaut.cz/${method}"` },
      body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soap:Body><${method} xmlns="https://is.skaut.cz/"><${wrapper}>${input}</${wrapper}></${method}></soap:Body></soap:Envelope>`,
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
    });
  } catch { throw createHttpError("skautIS is unavailable. Try again later.", 502); }
  if (!response.body) throw createHttpError("skautIS is unavailable.", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw createHttpError("skautIS response is too large.", 502);
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = parseSkautisResult(Buffer.concat(chunks).toString("utf8"), method, limit);
  if (!response.ok) throw createHttpError("skautIS is unavailable.", 502);
  return result;
}
