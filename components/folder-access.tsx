"use client";

import { useEffect, useState } from "react";
import { useConfig } from "@/contexts/config-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FolderEditorPicker } from "@/components/folder-editor-picker";
import { toast } from "sonner";

type Folder = { directory?: string; directories: string[]; editors?: string[]; inheritedFrom?: string | null; branch: string; head?: string };

export function FolderAccess() {
  const { config } = useConfig();
  const [directory, setDirectory] = useState("");
  const [data, setData] = useState<Folder | null>(null);
  const [editorText, setEditorText] = useState("");
  const editors = [...new Set(editorText.split("\n").map(value => value.trim()).filter(Boolean))];
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = config ? `/api/${config.owner}/${config.repo}/${encodeURIComponent(config.branch)}/folder-access` : "";
  async function load(folder?: string) {
    if (!endpoint) return;
    setBusy(true); setError(""); setData(null);
    try {
      const response = await fetch(endpoint + (folder === undefined ? "" : `?directory=${encodeURIComponent(folder)}`), { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Could not load folder permissions.");
      setData(result); setEditorText((result.editors || []).join("\n"));
      if (result.directory !== undefined) setDirectory(result.directory);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not load folder permissions."); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [endpoint]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="max-w-2xl space-y-5">
    <h1 className="text-xl font-semibold">Folder access</h1>
    <p className="text-sm text-muted-foreground">Manage who can edit each folder. Changes apply to all branches. Folder administrators are maintained in Git.</p>
    {data && <p className="text-sm">Permission branch: {data.branch}</p>}
    {data && data.directories.length > 0 && <div className="flex gap-2 flex-wrap">{data.directories.map(path => <Button variant="outline" key={path} disabled={busy} onClick={() => void load(path)}>{path || "/"}</Button>)}</div>}
    {data && !data.directories.length && !data.head && <p>You are not an administrator of any folder.</p>}
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void load(directory); }}>
      <Input aria-label="Folder path" placeholder="Folder path (empty for repository root)" value={directory} onChange={event => { setDirectory(event.target.value); setData(null); }} disabled={busy} />
      <Button disabled={busy}>Open</Button>
    </form>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {data?.head && <div className="space-y-3">
      {data.inheritedFrom !== null && data.inheritedFrom !== data.directory && <p className="text-sm">Currently inherited from {data.inheritedFrom || "/"}. Saving creates a rule for this folder.</p>}
      <FolderEditorPicker endpoint={endpoint} directory={data.directory || ""} editors={editors} manualValue={editorText} onManualChange={setEditorText} names={names} onName={(identity, name) => setNames(current => ({ ...current, [identity]: name }))} onChange={values => setEditorText(values.join("\n"))} disabled={busy} />
      <Button disabled={busy || directory !== data.directory} onClick={async () => {
        setBusy(true); setError("");
        try {
          const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ directory: data.directory, head: data.head, editors }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.message || "Could not save folder permissions.");
          toast.success("Folder editors updated."); await load(data.directory);
        } catch (error) { setError(error instanceof Error ? error.message : "Could not save folder permissions."); }
        finally { setBusy(false); }
      }}>Save editors</Button>
    </div>}
  </div>;
}
