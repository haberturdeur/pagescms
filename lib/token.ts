/**
 * Token helper functions.
 */

import { cache } from "react";
import { createOctokitInstance } from "@/lib/utils/octokit";
import { db } from "@/db";
import { User } from "@/types/user";
import { getGithubAccount } from "@/lib/github-account";
import { createHttpError } from "@/lib/api-error";
import { collaboratorMatchesUserForRepo } from "@/lib/collaborator-access";

import { getInstallationToken } from "@/lib/installation-token";
import { getSkautisRepositoryAccess } from "@/lib/skautis/repositories";
import { skautisOnly } from "@/lib/skautis/config";

// Get a token for a user (including collagborators who need to provide an owner/repo scope).
const getToken = cache(async (
  user: User,
  owner: string,
  repo: string,
  verifyGithubAccess: boolean = false,
) => {
  const skautis = await getSkautisRepositoryAccess(user, owner, repo);
  if (skautis) return { token: skautis.token, source: "installation" as const };
  if (skautisOnly()) throw createHttpError("You are not listed in this repository's .access or .admins files.", 403);
  const githubAccount = await getGithubAccount(user.id);
  if (githubAccount?.accessToken) {
    const hasGithubAccess = await canAccessRepoWithToken(githubAccount.accessToken, owner, repo);
    if (hasGithubAccess) return {
      token: githubAccount.accessToken,
      source: "user" as const,
    };
  }

  const permission = await db.query.collaboratorTable.findFirst({
    where: collaboratorMatchesUserForRepo(user, owner, repo),
  });
  if (permission) {
    const installationToken = await getInstallationToken(owner, repo);

    return {
      token: installationToken,
      source: "installation" as const,
    };
  }

  if (githubAccount?.accessToken && verifyGithubAccess) {
    throw createHttpError(
      `You do not have permission to access "${owner}/${repo}".`,
      403,
    );
  }

  throw createHttpError(
    `You do not have permission to access "${owner}/${repo}".`,
    403,
  );
});

// Get the GitHub user token.
const getUserToken = cache(async (userId: string) => {
  const githubAccount = await getGithubAccount(userId);
  if (!githubAccount?.accessToken) throw new Error(`GitHub token not found for user ${userId}.`);

  return githubAccount.accessToken;
});

const canAccessRepoWithToken = async (
  token: string,
  owner: string,
  repo: string,
) => {
  try {
    const octokit = createOctokitInstance(token);
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return data.permissions?.push === true;
  } catch {
    return false;
  }
};

export { getInstallationToken, getUserToken, getToken };
