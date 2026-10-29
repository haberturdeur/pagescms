import { callSkautis, parseSkautisResult, type SoapRecord } from "./soap";
import { getSkautisConfig } from "./config";

function loginIdentity(detail: SoapRecord) {
  const userId = detail.ID_User;
  const expiresAt = typeof detail.DateLogout === "string" ? Date.parse(detail.DateLogout) : NaN;
  if (typeof userId !== "string" || !/^[1-9]\d*$/.test(userId) || !Number.isSafeInteger(Number(userId))
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Invalid or expired skautIS session.");
  }
  const name = typeof detail.CivilName === "string" ? detail.CivilName : typeof detail.Person === "string" ? detail.Person : `skautIS ${userId}`;
  const unitId = typeof detail.ID_UnitRole === "string" && /^[1-9]\d*$/.test(detail.ID_UnitRole) ? detail.ID_UnitRole : undefined;
  return { userId, expiresAt, name: name.slice(0, 200), unitId };
}

export function parseLoginDetail(xml: string) {
  return loginIdentity(parseSkautisResult(xml, "LoginDetail", 65536));
}

export async function verifySkautisLogin(token: string) {
  const detail = await callSkautis("LoginDetail", token);
  const config = getSkautisConfig();
  if (!config) throw new Error("skautIS is disabled.");
  return { ...loginIdentity(detail), environment: config.environment };
}
