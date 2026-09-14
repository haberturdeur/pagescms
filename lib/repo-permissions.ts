export type WriteOperation = "create" | "update" | "delete";
export type PermissionRule = { paths: string[]; operations: WriteOperation[] };
export type RepoPermissions = { admin: boolean; restricted: boolean; rules: PermissionRule[] };
export type AccessPolicy = { version: 1; groups: Record<string, string[]>; rules: (PermissionRule & { groups: string[] })[] };
export const accessPolicyPath = ".pages-access.yml";

export function canonicalRepoPath(path: string): string {
  if (typeof path !== "string" || !path || path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(path)
    || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) {
    throw new Error("Invalid repository path.");
  }
  return path;
}

export function protectedRepoPath(path: string) {
  return path === accessPolicyPath || path === ".pages.yml" || path === ".github" || path.startsWith(".github/");
}

export function matchesPath(pattern: string, path: string): boolean {
  const parts = pattern.split("/");
  const segments = path.split("/");
  const memo = new Map<string, boolean>();
  const match = (p: number, s: number): boolean => {
    const key = `${p}:${s}`;
    if (memo.has(key)) return memo.get(key)!;
    let result: boolean;
    if (p === parts.length) result = s === segments.length;
    else if (parts[p] === "**") result = match(p + 1, s) || (s < segments.length && match(p, s + 1));
    else {
      const regex = parts[p].split(/(\*|\?)/).map(part => part === "*" ? ".*" : part === "?" ? "." : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
      result = s < segments.length && new RegExp(`^${regex}$`, "u").test(segments[s]) && match(p + 1, s + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

export function canWrite(permissions: RepoPermissions | undefined, path: string, operation: WriteOperation): boolean {
  try { canonicalRepoPath(path); } catch { return false; }
  if (!permissions) return false;
  if (permissions.admin) return true;
  if (protectedRepoPath(path)) return false;
  return !permissions.restricted || permissions.rules.some(rule => rule.operations.includes(operation)
    && rule.paths.some(pattern => matchesPath(pattern, path)));
}

// An optimistic UI hint for creating a not-yet-named file. The server always
// checks the final path, including conflict-generated names.
export function canCreateWithin(permissions: RepoPermissions | undefined, directory: string): boolean {
  if (directory) { try { canonicalRepoPath(directory); } catch { return false; } }
  if (!permissions) return false;
  if (permissions.admin) return true;
  if (protectedRepoPath(directory)) return false;
  if (!permissions.restricted) return true;
  return permissions.rules.some(rule => rule.operations.includes("create") && rule.paths.some(pattern => {
    const fixed = pattern.split("/").filter((_, index, parts) => parts.slice(0, index + 1).every(p => !/[?*]/.test(p))).join("/");
    return !directory || !fixed || fixed === directory || fixed.startsWith(directory + "/") || directory.startsWith(fixed + "/");
  }));
}

export function permissionsForEmail(policy: AccessPolicy | null, email: string, verified: boolean): RepoPermissions {
  if (!policy) return { admin: false, restricted: false, rules: [] };
  const normalized = email.trim().toLowerCase();
  const memberships = new Set(verified ? Object.entries(policy.groups)
    .filter(([, members]) => members.some(member => member.trim().toLowerCase() === normalized)).map(([name]) => name) : []);
  return { admin: false, restricted: true, rules: policy.rules
    .filter(rule => rule.groups.some(group => memberships.has(group)))
    .map(({ paths, operations }) => ({ paths, operations })) };
}
