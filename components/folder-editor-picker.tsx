"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { DirectoryPerson, DirectoryUnit } from "@/lib/skautis/directory";

type Props = {
  endpoint: string;
  directory: string;
  editors: string[];
  manualValue: string;
  onManualChange: (value: string) => void;
  names: Record<string, string>;
  onName: (identity: string, name: string) => void;
  onChange: (editors: string[]) => void;
  disabled: boolean;
};

export function FolderEditorPicker({ endpoint, directory, editors, manualValue, onManualChange, names, onName, onChange, disabled }: Props) {
  const unitInput = useId(), searchInput = useId(), manualInput = useId();
  const [units, setUnits] = useState<DirectoryUnit[]>([]);
  const [unit, setUnit] = useState("");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [loadingUnits, setLoadingUnits] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const url = `${endpoint}/people?directory=${encodeURIComponent(directory)}`;

  useEffect(() => {
    const controller = new AbortController();
    setLoadingUnits(true); setUnits([]); setUnit(""); setError(""); setQuery(""); setPeople([]);
    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Could not load your skautIS units.");
        if (!controller.signal.aborted) { setUnits(result.units); setUnit(result.defaultUnit || ""); }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load units.");
      } finally { if (!controller.signal.aborted) setLoadingUnits(false); }
    })();
    return () => controller.abort();
  }, [url]);

  useEffect(() => {
    setPeople([]); setHasMore(false); setSearched(false); setSearching(false);
    if (!unit || (query.match(/[\p{L}\p{N}]/gu)?.length || 0) < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true); setError("");
      void (async () => {
        try {
          const response = await fetch(`${url}&unit=${encodeURIComponent(unit)}&q=${encodeURIComponent(query.trim())}`, { cache: "no-store", signal: controller.signal });
          const result = await response.json();
          if (!response.ok) throw new Error(result.message || "Could not search this unit.");
          if (!controller.signal.aborted) { setPeople(result.people); setHasMore(result.hasMore); setSearched(true); }
        } catch (error) {
          if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not search this unit.");
        } finally { if (!controller.signal.aborted) setSearching(false); }
      })();
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [url, unit, query]);

  return <div className="space-y-4">
    <div className="space-y-2">
      <Label htmlFor={unitInput}>Search in unit</Label>
      <select id={unitInput} className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={unit} onChange={event => { setUnit(event.target.value); setQuery(""); setError(""); }} disabled={disabled || loadingUnits || !units.length}>
        {!units.length && <option value="">{loadingUnits ? "Loading units…" : "No units available"}</option>}
        {units.map(value => <option key={value.id} value={value.id}>{value.name}{value.registrationNumber ? ` (${value.registrationNumber})` : ""}</option>)}
      </select>
      <Label htmlFor={searchInput}>Find a person</Label>
      <Input id={searchInput} placeholder="Type at least two letters of a name" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} disabled={disabled || !unit} />
      <p className="text-xs text-muted-foreground">Select individual people to add as editors. Only active skautIS accounts are selectable.</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div aria-live="polite" aria-busy={searching}>
      {searching && <p className="text-sm">Searching…</p>}
      {searched && !searching && !people.length && <p className="text-sm text-muted-foreground">No matching active accounts in this unit.</p>}
      {!!people.length && <ul className="divide-y rounded-md border">{people.map(person => <li key={person.identity} className="flex items-center justify-between gap-3 p-3">
        <div><p className="text-sm font-medium">{person.name}</p><p className="text-xs text-muted-foreground">{person.username || person.identity}</p></div>
        <Button type="button" size="sm" variant="outline" disabled={disabled || editors.includes(person.identity)} aria-label={`Add ${person.name}`} onClick={() => { onName(person.identity, person.name); onChange([...editors, person.identity]); }}>
          {editors.includes(person.identity) ? "Added" : "Add"}
        </Button>
      </li>)}</ul>}
      {hasMore && <p className="text-xs text-muted-foreground">More matches are available. Enter more of the name to narrow the search.</p>}
    </div>
    <div className="space-y-2">
      <p className="text-sm font-medium">Allowed editors</p>
      {!editors.length && <p className="text-sm text-muted-foreground">No editors selected. Saving an empty list blocks content editing in this folder.</p>}
      <ul className="space-y-2">{editors.map(identity => <li key={identity} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
        <span className="break-all">{names[identity] || identity}</span>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={`Remove ${names[identity] || identity}`} onClick={() => onChange(editors.filter(value => value !== identity))}>Remove</Button>
      </li>)}</ul>
    </div>
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Edit identities manually</summary>
      <Label htmlFor={manualInput} className="mt-3 mb-2">One editor identity per line</Label>
      <Textarea id={manualInput} rows={6} value={manualValue} onChange={event => onManualChange(event.target.value)} disabled={disabled} />
    </details>
  </div>;
}
