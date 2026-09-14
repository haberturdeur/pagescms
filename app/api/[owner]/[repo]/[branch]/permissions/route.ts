import { requireApiUserSession } from "@/lib/session-server";
import { getToken } from "@/lib/token";
import { getRepoAccess } from "@/lib/repo-access";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: Request, context: { params: Promise<{ owner: string; repo: string; branch: string }> }) {
  try {
    const session = await requireApiUserSession();
    if ("response" in session) return session.response;
    const { owner, repo } = await context.params;
    const { token, source } = await getToken(session.user, owner, repo);
    const { permissions } = await getRepoAccess(session.user, owner, repo, token, source);
    // Never return group membership lists or another user's email addresses.
    return Response.json(permissions, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return toErrorResponse(error); }
}
