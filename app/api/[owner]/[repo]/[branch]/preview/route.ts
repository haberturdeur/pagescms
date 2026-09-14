import { requireApiUserSession } from "@/lib/session-server";
import { getToken } from "@/lib/token";
import { getConfig } from "@/lib/config-store";
import { createOctokitInstance } from "@/lib/utils/octokit";
import { previewRequest } from "@/lib/preview";
import { createHttpError, toErrorResponse } from "@/lib/api-error";

type Context = { params: Promise<{ owner: string; repo: string; branch: string }> };
async function handle(request: Request, context: Context) {
  try {
    const session = await requireApiUserSession();
    if ("response" in session) return session.response;
    const { owner, repo, branch } = await context.params;
    const { token } = await getToken(session.user, owner, repo);
    const config = await getConfig(owner, repo, branch, { getToken: async () => token });
    if (config?.object?.settings?.preview !== true) throw createHttpError("Previews are not enabled for this repository.", 404);
    // A preview is a read operation, including for collaborators with restricted edits.
    // Pin the server-resolved commit; do not accept a client-supplied ref or URL.
    let build;
    if (request.method === "POST") {
      const { data } = await createOctokitInstance(token).rest.repos.getBranch({ owner, repo, branch });
      build = { sha: data.commit.sha, token };
    }
    const result = await previewRequest(request.method === "POST" ? "POST" : "GET", `${owner}/${repo}`, branch, build);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return toErrorResponse(error); }
}
export const GET = handle;
export const POST = handle;
