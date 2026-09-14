"use client";
import { useState } from "react";
import useSWR from "swr";
import { ExternalLink, Loader } from "lucide-react";
import { useConfig } from "@/contexts/config-context";
import { Button } from "@/components/ui/button";

type Preview = { status: "idle" | "queued" | "building" | "ready" | "failed"; sha?: string; url?: string; error?: string };
export function RepoPreview() {
  const { config } = useConfig();
  const enabled = config?.object?.settings?.preview === true;
  const endpoint = enabled ? `/api/${config.owner}/${config.repo}/${encodeURIComponent(config.branch)}/preview` : null;
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string>();
  const { data, error, mutate } = useSWR<Preview>(endpoint, async url => {
    const response = await fetch(url, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || "Could not load preview.");
    return body;
  }, { refreshInterval: data => data?.status === "building" || data?.status === "queued" ? 2000 : 0 });
  if (!enabled) return null;
  const busy = submitting || data?.status === "queued" || data?.status === "building";
  async function build() {
    setSubmitting(true); setFailure(undefined);
    try {
      const response = await fetch(endpoint!, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "Could not build preview.");
      await mutate(body);
    } catch (error) { setFailure(error instanceof Error ? error.message : "Could not build preview."); }
    finally { setSubmitting(false); }
  }
  return <section className="border-b bg-muted/30 px-4 py-2 md:px-6" aria-label="Branch preview">
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Button size="sm" variant="outline" disabled={busy} onClick={build}>
        {busy && <Loader className="size-4 animate-spin" />}{busy ? "Building preview…" : "Build preview"}
      </Button>
      {data?.status === "ready" && data.url && <Button asChild size="sm" variant="outline"><a href={data.url} target="_blank" rel="noopener noreferrer">Open preview <ExternalLink className="size-4" /></a></Button>}
      <span className="text-muted-foreground">{data?.sha ? `Saved commit ${data.sha.slice(0, 7)}` : "Builds saved changes, including drafts."}</span>
    </div>
    {(failure || error || data?.error) && <p role="alert" className="mt-2 whitespace-pre-wrap text-sm text-destructive">{failure || error?.message || data?.error}</p>}
  </section>;
}
