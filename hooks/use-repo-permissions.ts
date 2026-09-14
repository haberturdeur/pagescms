"use client";
import { useCallback } from "react";
import useSWR from "swr";
import { canWrite, canCreateWithin, type RepoPermissions, type WriteOperation } from "@/lib/repo-permissions";

export function useRepoPermissions({ owner, repo, branch }: { owner: string; repo: string; branch: string }) {
  const { data, error } = useSWR<RepoPermissions>(
    `/api/${owner}/${repo}/${encodeURIComponent(branch)}/permissions`,
    async url => {
      const response = await fetch(url, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Could not load permissions.");
      return payload;
    },
    { revalidateOnFocus: true },
  );
  // Cached UI permissions are only hints. Every mutation reloads policy server-side.
  const permissions = error ? undefined : data;
  const can = useCallback((path: string, operation: WriteOperation) => canWrite(permissions, path, operation), [permissions]);
  const canCreate = useCallback((directory: string) => canCreateWithin(permissions, directory), [permissions]);
  return { can, canCreate, ready: Boolean(data), error,
    repositoryActions: Boolean(permissions && (permissions.admin || !permissions.restricted)) };
}
