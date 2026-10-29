import { createHttpError } from "@/lib/api-error";
import { callSkautis, type SoapRecord } from "./soap";
import { getSkautisConfig } from "./config";

export type DirectoryUnit = { id: string; name: string; registrationNumber: string };
export type DirectoryPerson = { identity: string; name: string; username: string };
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
const text = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 200) : "";
const rows = (value: unknown): SoapRecord[] => (Array.isArray(value) ? value : value && typeof value === "object" ? [value] : []).filter(row => row && typeof row === "object");
const normalized = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("cs");

export async function getDirectoryUnits(token: string, accountId: string) {
  const config = getSkautisConfig();
  const [environment, userId] = accountId.split(":");
  if (!config || environment !== config.environment || !id(userId)) throw createHttpError("Invalid skautIS account.", 401);
  const result = await callSkautis("UserRoleAll", token, { ID_User: Number(userId), ID_Role: null, IsActive: true, CanEdit: null, ID: null }, 1048576);
  const units = new Map<string, DirectoryUnit>();
  for (const row of rows(result.UserRoleAllOutput)) {
    if (!id(row.ID_Unit) || row.IsActive !== "true") continue;
    const name = text(row.Unit);
    if (name) units.set(row.ID_Unit, { id: row.ID_Unit, name, registrationNumber: text(row.RegistrationNumber) });
  }
  return [...units.values()].sort((a, b) => a.name.localeCompare(b.name, "cs"));
}

export function validateDirectoryQuery(query: string) {
  const cleaned = query.trim();
  if (cleaned.length > 100 || (cleaned.match(/[\p{L}\p{N}]/gu)?.length || 0) < 2 || /[\x00-\x1f\x7f]/.test(cleaned)) {
    throw createHttpError("Enter at least two letters of a person's name (at most 100 characters).", 400);
  }
  return cleaned;
}

export async function searchDirectory(token: string, accountId: string, unitId: string, query: string) {
  const cleaned = validateDirectoryQuery(query);
  const units = await getDirectoryUnits(token, accountId);
  if (!units.some(unit => unit.id === unitId)) throw createHttpError("Select a unit available to your skautIS account.", 403);
  const result = await callSkautis("UserAll", token, { ID: null, ID_Person: null, ID_Unit: Number(unitId), DisplayName: cleaned }, 1048576);
  const people = new Map<string, DirectoryPerson>();
  const environment = accountId.split(":")[0];
  for (const row of rows(result.UserAllOutput)) {
    if (!id(row.ID) || row.IsEnabled !== "true") continue;
    const name = text(row.DisplayName) || text(row.UserName);
    const username = text(row.UserName);
    if (!name || !normalized(`${name} ${username}`).includes(normalized(cleaned))) continue;
    const identity = `skautis:${environment}:${row.ID}`;
    people.set(identity, { identity, name, username });
  }
  const sorted = [...people.values()].sort((a, b) => a.name.localeCompare(b.name, "cs"));
  return { people: sorted.slice(0, 50), hasMore: sorted.length > 50 };
}
