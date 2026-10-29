import { admittedByFolders, readFolderPolicies, type FolderActor } from "@/lib/folder-policy";
import { getInstallationToken } from "@/lib/installation-token";
import { getSkautisAccount } from "./account";
import { skautisRepositories } from "./config";

export async function repositoriesForSkautisActor(actor: FolderActor) {
  const allowed = [];
  for (const { owner, repo } of skautisRepositories()) {
    // Fail closed on unavailable/invalid policies; never issue a login based on
    // stale admission. The GitHub App must already be installed on each repo.
    const token = await getInstallationToken(owner, repo);
    const policies = await readFolderPolicies(token, owner, repo);
    if (admittedByFolders(policies, actor)) allowed.push({ owner, repo, token, policies });
  }
  return allowed;
}

export async function getSkautisRepositoryAccess(user: { id: string; email: string; emailVerified: boolean }, owner: string, repo: string) {
  if (!skautisRepositories().some(entry => entry.owner === owner.toLowerCase() && entry.repo === repo.toLowerCase())) return null;
  const account = await getSkautisAccount(user.id);
  if (!account) return null;
  const token = await getInstallationToken(owner, repo);
  const policies = await readFolderPolicies(token, owner, repo);
  return admittedByFolders(policies, { ...user, skautisAccountId: account.accountId }) ? { token, policies } : null;
}

export async function getSkautisRepositoriesForUser(user: { id: string; email: string; emailVerified: boolean }) {
  const account = await getSkautisAccount(user.id);
  if (!account) return [];
  return repositoriesForSkautisActor({ ...user, skautisAccountId: account.accountId });
}
