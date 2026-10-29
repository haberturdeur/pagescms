import { requireApiUserSession } from "@/lib/session-server";
import { getToken } from "@/lib/token";
import { getSkautisAccount } from "@/lib/skautis/account";
import { effectiveFolderGrants, readFolderPolicies } from "@/lib/folder-policy";
import { canonicalRepoPath } from "@/lib/repo-permissions";
import { createHttpError } from "@/lib/api-error";

export type FolderManagementContext = { params: Promise<{ owner: string; repo: string; branch: string }> };

export async function getFolderManagement(context: FolderManagementContext) {
  const session = await requireApiUserSession();
  if ("response" in session) throw createHttpError("Not signed in.", 401);
  const { owner, repo } = await context.params;
  const { token } = await getToken(session.user, owner, repo);
  const policies = await readFolderPolicies(token, owner, repo);
  const account = await getSkautisAccount(session.user.id);
  const actor = { ...session.user, skautisAccountId: account?.accountId };
  const permissions = { admin: false, restricted: true, rules: [], folderAdmins: effectiveFolderGrants(policies.admins, actor) };
  return { owner, repo, token, policies, permissions, user: session.user, session: session.session };
}

export function validateFolderDirectory(directory: string) {
  if (directory) { try { canonicalRepoPath(directory); } catch { throw createHttpError("Invalid folder path.", 400); } }
  return directory;
}
