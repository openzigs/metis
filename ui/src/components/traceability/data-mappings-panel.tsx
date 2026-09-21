"use client";

/**
 * Requirement ↔ data traceability panel (Epic #889, issue #894).
 *
 * Renders the data mappings linked to a single requirement, supports adding /
 * removing mappings against the #892 API, and surfaces LLM-suggested candidates
 * from the #893 endpoint with confidence + rationale and one-click accept.
 *
 * Loading / empty / error states are handled and all controls are
 * keyboard-accessible with explicit labels.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  CreateRequirementDataMappingInput,
  SuggestedDataMappingCandidate,
} from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { dataMappingsApi } from "@/lib/data-mappings-api";
import { dbConnectorsApi } from "@/lib/connectors-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface DataMappingsPanelProps {
  projectId: string;
  requirementId: string;
}

export function dataMappingsKey(projectId: string, requirementId: string) {
  return ["data-mappings", projectId, requirementId] as const;
}

/** Render a 0–1 confidence as a percentage badge. */
function ConfidenceBadge({
  confidence,
  lowConfidence,
}: {
  confidence: number;
  lowConfidence?: boolean;
}): React.ReactElement {
  const pct = Math.round(confidence * 100);
  return <Badge variant={lowConfidence ? "outline" : "secondary"}>{pct}% confidence</Badge>;
}

/** Compose a `schema.table.column` display path. */
function targetPath(m: {
  schemaName: string | null;
  tableName: string;
  columnName: string | null;
}): string {
  const table = m.schemaName ? `${m.schemaName}.${m.tableName}` : m.tableName;
  return m.columnName ? `${table}.${m.columnName}` : table;
}

export function DataMappingsPanel({
  projectId,
  requirementId,
}: DataMappingsPanelProps): React.ReactElement {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    dbConnectorId: "",
    schemaName: "",
    tableName: "",
    columnName: "",
    note: "",
  });
  const [candidates, setCandidates] = useState<SuggestedDataMappingCandidate[] | null>(null);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);

  const mappings = useQuery({
    queryKey: dataMappingsKey(projectId, requirementId),
    queryFn: async () => (await dataMappingsApi.list(projectId, requirementId)) ?? [],
    enabled: Boolean(projectId && requirementId),
  });

  const connectors = useQuery({
    queryKey: ["db-connectors", projectId],
    queryFn: async () => (await dbConnectorsApi.list(projectId)) ?? [],
    enabled: Boolean(projectId),
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: dataMappingsKey(projectId, requirementId) });

  const createMutation = useMutation({
    mutationFn: (body: CreateRequirementDataMappingInput) =>
      dataMappingsApi.create(projectId, requirementId, body),
    onSuccess: () => {
      void invalidate();
      toast.success("Data mapping added");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to add mapping");
    },
  });

  const removeMutation = useMutation({
    mutationFn: (mappingId: string) => dataMappingsApi.remove(projectId, requirementId, mappingId),
    onSuccess: () => {
      void invalidate();
      toast.success("Data mapping removed");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to remove mapping");
    },
  });

  const suggestMutation = useMutation({
    mutationFn: () => dataMappingsApi.suggest(projectId, requirementId),
    onSuccess: (result) => {
      setCandidates(result.candidates);
      setSuggestNote(result.note);
      if (result.candidates.length === 0 && !result.note) {
        setSuggestNote("No suggestions found.");
      }
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to fetch suggestions");
    },
  });

  function resetForm(): void {
    setForm({ dbConnectorId: "", schemaName: "", tableName: "", columnName: "", note: "" });
    setShowForm(false);
  }

  function submitForm(e: React.FormEvent): void {
    e.preventDefault();
    if (!form.dbConnectorId || !form.tableName.trim()) {
      toast.error("Connector and table are required");
      return;
    }
    const body: CreateRequirementDataMappingInput = {
      dbConnectorId: form.dbConnectorId,
      tableName: form.tableName.trim(),
      schemaName: form.schemaName.trim() || null,
      columnName: form.columnName.trim() || null,
      note: form.note.trim() || null,
    };
    createMutation.mutate(body, { onSuccess: resetForm });
  }

  function acceptCandidate(c: SuggestedDataMappingCandidate): void {
    createMutation.mutate(
      {
        dbConnectorId: c.dbConnectorId,
        tableName: c.tableName,
        schemaName: c.schemaName,
        columnName: c.columnName,
        confidence: c.confidence,
        source: "llm-suggested",
        note: c.rationale || null,
      },
      {
        onSuccess: () => {
          // Drop the accepted candidate from the suggestion list.
          setCandidates((prev) => (prev ? prev.filter((x) => x !== c) : prev));
        },
      },
    );
  }

  const list = mappings.data ?? [];

  return (
    <section
      aria-label="Data mappings"
      data-testid="data-mappings-panel"
      className="mt-3 rounded border border-zinc-800 bg-zinc-950/40 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Data mappings
        </h4>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowForm((v) => !v)}
            aria-expanded={showForm}
          >
            {showForm ? "Cancel" : "Add mapping"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => suggestMutation.mutate()}
            disabled={suggestMutation.isPending}
          >
            {suggestMutation.isPending ? "Suggesting…" : "Suggest mappings"}
          </Button>
        </div>
      </div>

      {/* List / loading / error / empty states */}
      {mappings.isLoading ? (
        <p className="mt-2 text-xs text-zinc-500" role="status">
          Loading mappings…
        </p>
      ) : mappings.isError ? (
        <p className="mt-2 text-xs text-red-400" role="alert">
          Failed to load data mappings.
        </p>
      ) : list.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-500">No data mappings linked yet.</p>
      ) : (
        <ul className="mt-2 space-y-1.5" aria-label="Linked data mappings">
          {list.map((m) => (
            <li
              key={m.id}
              data-testid="data-mapping-row"
              className="flex items-center justify-between gap-2 rounded bg-zinc-900/40 px-2 py-1.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-xs text-zinc-200">{targetPath(m)}</span>
                  <ConfidenceBadge confidence={m.confidence} />
                  {m.source === "llm-suggested" ? <Badge variant="outline">AI</Badge> : null}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {m.dbConnectorLabel ?? m.dbConnectorId}
                  {m.note ? ` · ${m.note}` : ""}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => removeMutation.mutate(m.id)}
                disabled={removeMutation.isPending}
                aria-label={`Remove mapping ${targetPath(m)}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Add-mapping form */}
      {showForm ? (
        <form onSubmit={submitForm} className="mt-3 space-y-2 border-t border-zinc-800 pt-3">
          <div>
            <Label htmlFor="dm-connector">Database connector</Label>
            <Select
              value={form.dbConnectorId}
              onValueChange={(v) => setForm((f) => ({ ...f, dbConnectorId: v }))}
            >
              <SelectTrigger id="dm-connector" aria-label="Database connector" className="mt-1">
                <SelectValue placeholder="Select a connector…" />
              </SelectTrigger>
              <SelectContent>
                {(connectors.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label htmlFor="dm-schema">Schema</Label>
              <Input
                id="dm-schema"
                value={form.schemaName}
                onChange={(e) => setForm((f) => ({ ...f, schemaName: e.target.value }))}
                placeholder="public"
              />
            </div>
            <div>
              <Label htmlFor="dm-table">Table</Label>
              <Input
                id="dm-table"
                value={form.tableName}
                onChange={(e) => setForm((f) => ({ ...f, tableName: e.target.value }))}
                placeholder="users"
                required
              />
            </div>
            <div>
              <Label htmlFor="dm-column">Column</Label>
              <Input
                id="dm-column"
                value={form.columnName}
                onChange={(e) => setForm((f) => ({ ...f, columnName: e.target.value }))}
                placeholder="email"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="dm-note">Note</Label>
            <Input
              id="dm-note"
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="Optional rationale"
            />
          </div>
          <Button type="submit" size="sm" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Saving…" : "Save mapping"}
          </Button>
        </form>
      ) : null}

      {/* Suggested candidates */}
      {candidates ? (
        <div
          className="mt-3 border-t border-zinc-800 pt-3"
          aria-label="Suggested data mappings"
          data-testid="data-mapping-suggestions"
        >
          {suggestNote ? (
            <p className="mb-2 text-[11px] text-amber-400" role="status">
              {suggestNote}
            </p>
          ) : null}
          {candidates.length === 0 ? null : (
            <ul className="space-y-1.5">
              {candidates.map((c, i) => (
                <li
                  key={`${c.dbConnectorId}-${c.schemaName ?? ""}-${c.tableName}-${c.columnName ?? ""}-${i}`}
                  data-testid="data-mapping-candidate"
                  className="flex items-center justify-between gap-2 rounded border border-dashed border-zinc-700 bg-zinc-900/30 px-2 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs text-zinc-200">
                        {targetPath(c)}
                      </span>
                      <ConfidenceBadge confidence={c.confidence} lowConfidence={c.lowConfidence} />
                    </div>
                    {c.rationale ? (
                      <div className="text-[11px] text-zinc-500">{c.rationale}</div>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => acceptCandidate(c)}
                    disabled={createMutation.isPending}
                    aria-label={`Accept suggestion ${targetPath(c)}`}
                  >
                    Accept
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
