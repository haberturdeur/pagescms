import { XMLParser, XMLValidator } from "fast-xml-parser";
import { getSkautisConfig, guidPattern } from "./config";

const namespace = "https://is.skaut.cz/";
const responseLimit = 64 * 1024;

export function parseLoginDetail(xml: string) {
  if (Buffer.byteLength(xml) > responseLimit || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error("Invalid skautIS response.");
  }
  const parsed = new XMLParser({ removeNSPrefix: true, parseTagValue: false, ignoreAttributes: false }).parse(xml);
  const body = parsed?.Envelope?.Body;
  if (body?.Fault) throw new Error("skautIS rejected the session.");
  const detail = body?.LoginDetailResponse?.LoginDetailResult;
  const userId = detail?.ID_User;
  const expiresAt = typeof detail?.DateLogout === "string" ? Date.parse(detail.DateLogout) : NaN;
  if (typeof userId !== "string" || !/^[1-9]\d*$/.test(userId) || !Number.isSafeInteger(Number(userId))
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Invalid or expired skautIS session.");
  }
  return { userId, expiresAt };
}

export async function verifySkautisLogin(token: string) {
  if (!guidPattern.test(token)) throw new Error("Invalid skautIS token.");
  const config = getSkautisConfig();
  if (!config) throw new Error("skautIS is disabled.");
  const response = await fetch(`${config.origin}/JunakWebservice/UserManagement.asmx`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${namespace}LoginDetail"` },
    body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><LoginDetail xmlns="${namespace}"><loginDetailInput><ID_Login>${token}</ID_Login></loginDetailInput></LoginDetail></soap:Body></soap:Envelope>`,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok || !response.body) throw new Error("skautIS is unavailable.");
  // Bound the response while streaming, rather than trusting Content-Length.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > responseLimit) throw new Error("skautIS response is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return { ...parseLoginDetail(Buffer.concat(chunks).toString("utf8")), environment: config.environment };
}
