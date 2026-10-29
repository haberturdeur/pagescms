import { type NextRequest } from "next/server";
import { createOctokitInstance } from "@/lib/utils/octokit";
import { getInstallations, getInstallationRepos } from "@/lib/github-app";
import { db } from "@/db";
import { and, sql } from "drizzle-orm";
import { collaboratorTable } from "@/db/schema";
import { getGithubAccount } from "@/lib/github-account";
import { hasGithubIdentity } from "@/lib/authz-shared";
import { toErrorResponse } from "@/lib/api-error";
import { requireApiUserSession } from "@/lib/session-server";
import { getSkautisRepositoriesForUser } from "@/lib/skautis/repositories";
import { skautisOnly } from "@/lib/skautis/config";
import { collaboratorMatchesUser } from "@/lib/collaborator-access";

export const dynamic = "force-dynamic";

/**
 * Fetches repositories for a user.
 * 
 * GET /api/repos/[owner]
 * 
 * Requires authentication.
 */

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ owner: string }> }
) {
  try {
    const params = await context.params;
    const sessionResult = await requireApiUserSession();
    if ("response" in sessionResult) return sessionResult.response;
    const user = sessionResult.user;

    let githubRepos: any[] = [];
    let collaboratorRepos: any[] = [];

    const searchParams = request.nextUrl.searchParams;
    const type = searchParams.get("type");

    const skautisRepos = [];
    for (const entry of await getSkautisRepositoriesForUser(user)) {
      if (entry.owner.toLowerCase() !== params.owner.toLowerCase()) continue;
      const { data } = await createOctokitInstance(entry.token).rest.repos.get({ owner: entry.owner, repo: entry.repo });
      skautisRepos.push({ owner: data.owner.login, repo: data.name, private: data.private, defaultBranch: data.default_branch, updatedAt: data.updated_at });
    }
    if (skautisOnly()) return Response.json({ status: "success", data: skautisRepos });
    const githubAccount = await getGithubAccount(user.id);
    if (githubAccount?.accessToken && hasGithubIdentity(user)) {
      const token = githubAccount.accessToken;

      const repositorySelection = searchParams.get("repository_selection");

      if (repositorySelection === "selected") {  
        // Only some repos are selected
        // TODO: investigate why it's slow
        const installations = await getInstallations(token, [params.owner]);
        if (installations.length === 1) {
          githubRepos = await getInstallationRepos(token, installations[0].id);
        }
      } else {
        // All repos are selected, we search for the repos based on parameters
        const keyword = searchParams.get("keyword");
        
        const octokit = createOctokitInstance(token);
        const query = `${keyword} in:name ${type}:${params.owner} fork:true`;
        const response = await octokit.rest.search.repos({
          q: query,
          sort: "updated",
          order: "desc",
          per_page: 5
        });
        githubRepos = response.data.items;
      }

      githubRepos = githubRepos.filter(repo => repo.permissions.push).map(repo => ({
        owner: repo.owner.login,
        repo: repo.name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        updatedAt: repo.updated_at,
      }));
    }

    collaboratorRepos = await db.query.collaboratorTable.findMany({
      where: and(
        collaboratorMatchesUser(user),
        sql`lower(${collaboratorTable.owner}) = lower(${params.owner})`
      )
    });

    const reposByKey = new Map<string, any>();
    for (const repo of [...githubRepos, ...skautisRepos]) {
      reposByKey.set(`${repo.owner.toLowerCase()}::${repo.repo.toLowerCase()}`, repo);
    }
    for (const repo of collaboratorRepos) {
      const key = `${repo.owner.toLowerCase()}::${repo.repo.toLowerCase()}`;
      if (!reposByKey.has(key)) {
        reposByKey.set(key, repo);
      }
    }

    const repos = Array.from(reposByKey.values());

    return Response.json({
      status: "success",
      data: repos,
    });
  } catch (error: any) {
    console.error(error);
    return toErrorResponse(error);
  }
}
