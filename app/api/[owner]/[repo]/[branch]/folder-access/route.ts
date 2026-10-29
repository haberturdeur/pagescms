import { stringify } from "yaml";
import { z } from "zod";
import { parseFolderList } from "@/lib/folder-policy";
import { canManageFolderAccess } from "@/lib/repo-permissions";
import { createOctokitInstance } from "@/lib/utils/octokit";
import { createHttpError, toErrorResponse } from "@/lib/api-error";

import { getFolderManagement as management, validateFolderDirectory as validateDirectory, type FolderManagementContext as Context } from "@/lib/folder-management";

export async function GET(request: Request, context: Context) {
  try {
    const { policies, permissions } = await management(context);
    const directory = validateDirectory(new URL(request.url).searchParams.get("directory") || "");
    const directories = [...new Set([...policies.access, ...policies.admins].map(list => list.directory))]
      .filter(path => canManageFolderAccess(permissions, path)).sort();
    if (!canManageFolderAccess(permissions, directory)) {
      // The index reveals only manageable paths; another folder's editor list
      // is returned only after checking that folder's own effective .admins.
      if (!new URL(request.url).searchParams.has("directory")) return Response.json({ directories, branch: policies.branch }, { headers: { "Cache-Control": "private, no-store" } });
      throw createHttpError("You are not listed in this folder's .admins file.", 403);
    }
    const list = policies.access.filter(entry => !entry.directory || directory === entry.directory || directory.startsWith(entry.directory + "/"))
      .sort((a, b) => b.directory.length - a.directory.length)[0];
    return Response.json({ directory, directories, editors: list?.members || [], inheritedFrom: list?.directory ?? null,
      branch: policies.branch, head: policies.commit }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return toErrorResponse(error); }
}

export async function PUT(request: Request, context: Context) {
  try {
    const parsed = z.object({ directory: z.string().max(4096), editors: z.array(z.string()).max(500), head: z.string().regex(/^[a-f0-9]{40}$/) }).strict().safeParse(await request.json());
    if (!parsed.success) throw createHttpError("Invalid folder permission request.", 400);
    const data = parsed.data;
    const directory = validateDirectory(data.directory);
    let editors: string[];
    try { editors = parseFolderList(JSON.stringify({ editors: data.editors }), "access"); }
    catch { throw createHttpError("Invalid editor identities.", 400); }
    const { owner, repo, token, policies, permissions } = await management(context);
    if (!canManageFolderAccess(permissions, directory)) throw createHttpError("You are not listed in this folder's .admins file.", 403);
    if (policies.commit !== data.head) throw createHttpError("Repository permissions changed. Reload before saving.", 409);
    const path = directory ? `${directory}/.access` : ".access";
    const octokit = createOctokitInstance(token);
    // Commit against the exact authorized snapshot. A concurrent .admins
    // revocation or any other commit makes the ref update non-fast-forward.
    const { data: tree } = await octokit.rest.git.createTree({ owner, repo, base_tree: policies.tree,
      tree: [{ path, mode: "100644", type: "blob", content: stringify({ editors }) }] });
    const { data: commit } = await octokit.rest.git.createCommit({ owner, repo,
      message: `Update folder editors: ${directory || "/"}`, tree: tree.sha, parents: [policies.commit] });
    try {
      await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${policies.branch}`, sha: commit.sha, force: false });
    } catch (error) {
      if ([409, 422].includes((error as { status?: number }).status || 0)) throw createHttpError("Repository changed. Reload and check permissions before retrying.", 409);
      throw error;
    }
    return Response.json({ status: "success" });
  } catch (error) { return toErrorResponse(error); }
}
