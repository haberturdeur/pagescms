import { getFolderManagement, validateFolderDirectory, type FolderManagementContext } from "@/lib/folder-management";
import { canManageFolderAccess } from "@/lib/repo-permissions";
import { getSkautisDirectorySession } from "@/lib/skautis/directory-session";
import { getDirectoryUnits, searchDirectory, validateDirectoryQuery } from "@/lib/skautis/directory";
import { createHttpError, toErrorResponse } from "@/lib/api-error";

export async function GET(request: Request, context: FolderManagementContext) {
  try {
    const params = new URL(request.url).searchParams;
    if (!params.has("directory")) throw createHttpError("Select the folder whose editors you are managing.", 400);
    const directory = validateFolderDirectory(params.get("directory") || "");
    const management = await getFolderManagement(context);
    if (!canManageFolderAccess(management.permissions, directory)) throw createHttpError("Only this folder's administrators can search for editors.", 403);
    if (!management.session?.id) throw createHttpError("Sign in with skautIS again to search.", 401);
    const unit = params.get("unit");
    const query = params.get("q");
    if (unit !== null || query !== null) {
      if (!unit || !/^[1-9]\d*$/.test(unit) || !Number.isSafeInteger(Number(unit)) || query === null) throw createHttpError("Select a unit and enter a name.", 400);
      validateDirectoryQuery(query);
    }
    const upstream = await getSkautisDirectorySession(management.session.id, management.user.id);
    const headers = { "Cache-Control": "private, no-store" };
    if (unit && query !== null) {
      const result = await searchDirectory(upstream.token, upstream.accountId, unit, query);
      return Response.json(result, { headers });
    }
    const units = await getDirectoryUnits(upstream.token, upstream.accountId);
    const defaultUnit = units.some(unit => unit.id === upstream.unitId) ? upstream.unitId : units[0]?.id;
    return Response.json({ units, defaultUnit }, { headers });
  } catch (error) {
    const response = toErrorResponse(error);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
