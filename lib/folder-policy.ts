import { parseDocument } from "yaml";
import { z } from "zod";
import { canonicalRepoPath, isFolderPolicyPath, type FolderGrant } from "@/lib/repo-permissions";
import { createOctokitInstance } from "@/lib/utils/octokit";

export type FolderList = { directory: string; path: string; sha: string; members: string[] };
export type FolderPolicies = { branch: string; commit: string; tree: string; access: FolderList[]; admins: FolderList[] };
export type FolderActor = { id?: string; email?: string; emailVerified?: boolean; skautisAccountId?: string };
const maxFileBytes = 32768;
const editor = z.string().trim().min(1).max(320).refine(value =>
  /^skautis:(test|production):[1-9]\d*$/.test(value)
  || /^user:[a-zA-Z0-9_-]+$/.test(value)
  || z.string().email().safeParse(value.replace(/^email:/, "")).success,
"Use skautis:test:123, skautis:production:123, user:CMS_ID or a verified email address.");

export function parseFolderList(source: string, kind: "access" | "admins") {
  if (Buffer.byteLength(source) > maxFileBytes) throw new Error("Permission file is too large.");
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("Invalid permission YAML.");
  const key = kind === "access" ? "editors" : "admins";
  const parsed = z.object({ [key]: z.array(editor).max(500) }).strict().parse(doc.toJS({ maxAliasCount: 0 }));
  return [...new Set(parsed[key])];
}

export function actorMatches(members: string[], actor: FolderActor) {
  return members.some(member => {
    if (member.startsWith("skautis:")) return Boolean(actor.skautisAccountId && member === `skautis:${actor.skautisAccountId}`);
    if (member.startsWith("user:")) return Boolean(actor.id && member === `user:${actor.id}`);
    return Boolean(actor.emailVerified && actor.email && member.replace(/^email:/, "").toLowerCase() === actor.email.trim().toLowerCase());
  });
}

export function effectiveFolderGrants(lists: FolderList[], actor: FolderActor): FolderGrant[] {
  return lists.map(list => ({ directory: list.directory, allowed: actorMatches(list.members, actor) }));
}

export async function readFolderPolicies(token: string, owner: string, repo: string): Promise<FolderPolicies> {
  const octokit = createOctokitInstance(token);
  const { data: repository } = await octokit.rest.repos.get({ owner, repo, request: { cache: "no-store" } });
  const { data: head } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${repository.default_branch}`, request: { cache: "no-store" } });
  const { data: tree } = await octokit.rest.git.getTree({ owner, repo, tree_sha: head.object.sha, recursive: "1", request: { cache: "no-store" } });
  if (tree.truncated) throw new Error("Cannot verify permissions in an incomplete repository tree.");
  const entries = tree.tree.filter(entry => entry.path && isFolderPolicyPath(entry.path));
  if (entries.length > 500) throw new Error("Too many permission files.");
  const access: FolderList[] = [], admins: FolderList[] = [];
  for (const entry of entries) {
    const path = canonicalRepoPath(entry.path!);
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode || "") || !entry.sha
      || path.split("/").slice(0, -1).some(part => part === ".access" || part === ".admins")) {
      throw new Error("Permission files must be regular files.");
    }
    const { data: content } = await octokit.rest.repos.getContent({ owner, repo, path, ref: head.object.sha, request: { cache: "no-store" } });
    if (Array.isArray(content) || content.type !== "file" || !("content" in content)
      || content.encoding !== "base64" || content.size > maxFileBytes || content.sha !== entry.sha) {
      throw new Error("Permission file could not be verified.");
    }
    const kind = path.split("/").at(-1) === ".access" ? "access" : "admins";
    const members = parseFolderList(Buffer.from(content.content, "base64").toString("utf8"), kind);
    const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    (kind === "access" ? access : admins).push({ path, directory, members, sha: entry.sha });
  }
  return { branch: repository.default_branch, commit: head.object.sha, tree: tree.sha, access, admins };
}

export function admittedByFolders(policies: FolderPolicies, actor: FolderActor) {
  return [...policies.access, ...policies.admins].some(list => actorMatches(list.members, actor));
}
