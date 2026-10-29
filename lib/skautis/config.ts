import { getBaseUrl } from "@/lib/base-url";

export const skautisCallbackPath = "/api/skautis/callback";
export const skautisHandoffCookie = "pagescms_skautis_handoff";
export const skautisStateCookie = "pagescms_skautis_state";
export const skautisFlowSeconds = 600;
export const guidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const skautisOnly = () => process.env.SKAUTIS_ONLY === "true";

export function skautisRepositories() {
  const repositories = (process.env.SKAUTIS_REPOSITORIES || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (repositories.length > 20 || repositories.some(value => !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/.test(value))) {
    throw new Error("SKAUTIS_REPOSITORIES must list owner/repo pairs (at most 20).");
  }
  return [...new Set(repositories)].map(value => { const [owner, repo] = value.split("/"); return { owner, repo }; });
}

export function getSkautisConfig() {
  const appId = process.env.SKAUTIS_APP_ID?.trim();
  if (!appId) return null;
  if (!guidPattern.test(appId)) throw new Error("SKAUTIS_APP_ID must be a GUID.");
  const environment = process.env.SKAUTIS_ENVIRONMENT || "test";
  if (environment !== "test" && environment !== "production") {
    throw new Error("SKAUTIS_ENVIRONMENT must be test or production.");
  }
  const baseUrl = new URL(getBaseUrl());
  if (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && baseUrl.hostname === "localhost")) {
    throw new Error("skautIS requires an HTTPS BASE_URL (or localhost for development).");
  }
  if (!process.env.CRYPTO_KEY) throw new Error("skautIS requires CRYPTO_KEY.");
  return {
    appId,
    environment,
    origin: environment === "test" ? "https://test-is.skaut.cz" : "https://is.skaut.cz",
    callbackUrl: new URL(skautisCallbackPath, baseUrl),
    secure: baseUrl.protocol === "https:",
  };
}

// Do not allow backslashes, control characters or protocol-relative redirects.
export function skautisRedirect(value: string | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20\x7f]/.test(value)) return "/";
  return value;
}
