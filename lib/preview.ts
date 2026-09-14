import { createHttpError } from "@/lib/api-error";

// The service address is controlled by the instance operator, never repository YAML.
export async function previewRequest(method: "GET" | "POST", repository: string, branch: string, build?: { sha: string; token: string }) {
  const endpoint = process.env.PREVIEW_SERVICE_URL;
  const secret = process.env.PREVIEW_SERVICE_TOKEN;
  if (!endpoint || !secret) throw createHttpError("Preview service is not configured.", 503);
  const url = new URL("/build", endpoint);
  url.searchParams.set("repository", repository);
  url.searchParams.set("branch", branch);
  const response = await fetch(url, {
    method, cache: "no-store", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    ...(build ? { body: JSON.stringify({ repository, branch, ...build }) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw createHttpError(result.message || "Preview service unavailable.", response.status);
  return result;
}
