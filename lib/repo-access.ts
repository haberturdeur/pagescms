import { parseDocument } from "yaml";
import { z } from "zod";
import { createOctokitInstance } from "@/lib/utils/octokit";
import { createHttpError } from "@/lib/api-error";
import { accessPolicyPath, canWrite, canonicalRepoPath, permissionsForEmail, type RepoPermissions, type WriteOperation } from "@/lib/repo-permissions";
import type { User } from "@/types/user";

const patternSchema = z.string().min(1).max(512).refine(pattern => {
  try { canonicalRepoPath(pattern); } catch { return false; }
  return !/[\[\]{}!]/.test(pattern) && pattern.split("/").every(part => !part.includes("**") || part === "**");
}, "Use repository-relative paths with *, ? or whole-segment ** wildcards.");
const policySchema = z.object({
  version: z.literal(1),
  groups: z.record(z.string().min(1), z.array(z.string().email()).max(1000)),
  rules: z.array(z.object({
    paths: z.array(patternSchema).min(1).max(100),
    groups: z.array(z.string()).min(1).max(100),
    operations: z.array(z.enum(["create", "update", "delete"])).default(["create", "update", "delete"]),
  }).strict()).max(200),
}).strict();

export function parseAccessPolicy(source: string) {
  if (Buffer.byteLength(source) > 131072) throw new Error("Access policy is too large.");
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error("Invalid access policy YAML.");
  const policy = policySchema.parse(document.toJS({ maxAliasCount: 0 }));
  if (policy.rules.some(rule => rule.groups.some(group => !Object.hasOwn(policy.groups, group)))) {
    throw new Error("Access policy references an undefined group.");
  }
  return policy;
}

export async function getRepoAccess(
  user: Pick<User, "email" | "emailVerified">,
  owner: string,
  repo: string,
  token: string,
  source: "user" | "installation",
) {
  const octokit = createOctokitInstance(token);
  // A public repository is readable by any GitHub account. Only genuine write
  // access qualifies as CMS administrator access; an installation token does not.
  const { data: repository } = await octokit.rest.repos.get({ owner, repo });
  let permissions: RepoPermissions;
  if (source === "user" && repository.permissions?.push) {
    permissions = { admin: true, restricted: false, rules: [] };
  } else {
    let policy = null;
    try {
      const { data: head } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${repository.default_branch}` });
      const { data: root } = await octokit.rest.git.getTree({ owner, repo, tree_sha: head.object.sha });
      if (root.truncated) throw new Error("Incomplete repository tree.");
      const entry = root.tree.find(item => item.path === accessPolicyPath);
      if (entry) {
        // Contents API can transparently follow symlinks. Check the Git mode first
        // so an editable target cannot become an indirect permissions policy.
        if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode || "")) throw new Error("Policy must be a regular file.");
        const { data: content } = await octokit.rest.repos.getContent({ owner, repo, path: accessPolicyPath, ref: head.object.sha });
        if (Array.isArray(content) || content.type !== "file" || !("content" in content) || content.size > 131072
          || content.encoding !== "base64") throw new Error("Expected a policy file.");
        policy = parseAccessPolicy(Buffer.from(content.content, "base64").toString("utf8"));
      }
    } catch {
      throw createHttpError("Repository permissions could not be verified. Ask an administrator to check .pages-access.yml or try again later.", 403);
    }
    permissions = permissionsForEmail(policy, user.email, user.emailVerified);
  }
  return {
    permissions,
    assert(path: string, operation: WriteOperation) {
      if (!canWrite(permissions, path, operation)) throw createHttpError(`You do not have permission to ${operation} "${path}".`, 403);
    },
    assertRepositoryAction() {
      if (permissions.restricted && !permissions.admin) {
        throw createHttpError("Only repository administrators can manage branches or run workflow actions when a permissions policy is enabled.", 403);
      }
    },
  };
}
