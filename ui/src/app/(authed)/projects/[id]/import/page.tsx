"use client";

/**
 * Epic #776 — Inbound Importers wizard + history.
 *
 * A single project tab that lets a user:
 *  1. pick an upstream source (GitHub / Jira / Azure DevOps / Linear),
 *  2. describe a filter, preview the matched issues (count + first 10),
 *  3. run the import (kicked off as a background task), and
 *  4. manage saved import sources: ongoing-sync toggle, interval, manual
 *     re-run, and deletion (with a confirm).
 */
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IMPORT_SOURCES,
  IMPORT_SYNC_DEFAULT_INTERVAL_MINUTES,
  IMPORT_SYNC_MIN_INTERVAL_MINUTES,
  type CreateImportSourceRequest,
  type ImportPreview,
  type ImportSourceKind,
  type ImportSourceView,
} from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { importApi } from "@/lib/import-api";
import { mapFieldErrors, type FieldErrorMap } from "@/lib/form-validation";
import { queryKeys } from "@/lib/query-keys";
import { useImportProgress } from "@/hooks/use-import-progress";
import { JobProgress } from "@/components/realtime/job-progress";
import { PausableLiveRegion } from "@/components/a11y/pausable-live-region";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

const SOURCE_LABELS: Record<ImportSourceKind, string> = {
  github: "GitHub",
  jira: "Jira",
  "azure-devops": "Azure DevOps",
  linear: "Linear",
};

type FilterState = Record<string, string>;

/** Build the per-source filter object the API expects from flat form fields. */
function buildFilter(source: ImportSourceKind, f: FilterState): Record<string, unknown> {
  switch (source) {
    case "github":
      return {
        owner: f.owner ?? "",
        repo: f.repo ?? "",
        state: f.state || "open",
        ...(f.labels
          ? {
              labels: f.labels
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
      };
    case "jira":
      return { connectionId: f.connectionId ?? "", jql: f.jql ?? "" };
    case "azure-devops":
      return {
        organization: f.organization ?? "",
        project: f.project ?? "",
        ...(f.workItemTypes
          ? {
              workItemTypes: f.workItemTypes
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
        ...(f.wiql ? { wiql: f.wiql } : {}),
      };
    case "linear":
      return {
        teamId: f.teamId ?? "",
        includeArchived: f.includeArchived === "true",
        ...(f.stateTypes
          ? {
              stateTypes: f.stateTypes
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
      };
    default:
      return {};
  }
}

/** Field descriptors drive the dynamic filter form. */
const SOURCE_FIELDS: Record<
  ImportSourceKind,
  Array<{ key: string; label: string; placeholder?: string }>
> = {
  github: [
    { key: "owner", label: "Owner / org", placeholder: "octocat" },
    { key: "repo", label: "Repository", placeholder: "hello-world" },
    { key: "labels", label: "Labels (comma-separated, optional)", placeholder: "bug, enhancement" },
    { key: "state", label: "State (open / closed / all)", placeholder: "open" },
  ],
  jira: [
    { key: "connectionId", label: "Jira connection ID" },
    { key: "jql", label: "JQL", placeholder: "project = ABC AND status != Done" },
  ],
  "azure-devops": [
    { key: "organization", label: "Organization" },
    { key: "project", label: "Project" },
    {
      key: "workItemTypes",
      label: "Work item types (comma-separated, optional)",
      placeholder: "Bug, User Story",
    },
    { key: "wiql", label: "WIQL (optional)" },
  ],
  linear: [
    { key: "teamId", label: "Team ID" },
    {
      key: "stateTypes",
      label: "State types (comma-separated, optional)",
      placeholder: "started, unstarted",
    },
    { key: "includeArchived", label: "Include archived (true / false)", placeholder: "false" },
  ],
};

export default function ImportPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();

  const [source, setSource] = useState<ImportSourceKind>("github");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [filter, setFilter] = useState<FilterState>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // #426 — per-field inline messages mapped from the server's friendly
  // validation envelope (`error.details.fields`). Cleared on a new attempt.
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // #424 — the active import run drives live progress + the terminal toast.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // Live progress for the active run (push). When the socket is connected this
  // renders a `<JobProgress>` bar + fires the terminal toast; the 10s sources
  // poll below is the fallback that backstops convergence if push is missed.
  const activeProgress = useImportProgress(activeRunId, projectId);

  const usesToken = source !== "jira";

  const sources = useQuery({
    queryKey: queryKeys.imports.sources(projectId),
    queryFn: () => importApi.listSources(projectId),
    enabled: Boolean(projectId),
    refetchInterval: 10_000,
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      importApi.preview(projectId, {
        source,
        filter: buildFilter(source, filter),
        token: token || undefined,
        baseUrl: baseUrl || undefined,
      }),
    onSuccess: (data) => {
      setPreview(data);
      setFormError(null);
      setFieldErrors({});
    },
    onError: (err: unknown) => {
      const mapped = mapFieldErrors(err);
      setFieldErrors(mapped);
      setFormError(
        Object.keys(mapped).length > 0
          ? null
          : err instanceof ApiError
            ? err.message
            : "Preview failed",
      );
    },
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const body: CreateImportSourceRequest = {
        source,
        label: label || `${SOURCE_LABELS[source]} import`,
        filter: buildFilter(source, filter),
        token: token || undefined,
        baseUrl: baseUrl || undefined,
        syncEnabled: false,
        syncIntervalMinutes: IMPORT_SYNC_DEFAULT_INTERVAL_MINUTES,
      };
      return importApi.createSource(projectId, body);
    },
    onSuccess: (data) => {
      setPreview(null);
      setLabel("");
      setToken("");
      setFilter({});
      setFormError(null);
      setFieldErrors({});
      // #424 — track the kicked-off run so its progress streams live.
      setActiveRunId(data.run.id);
      void qc.invalidateQueries({ queryKey: queryKeys.imports.sources(projectId) });
    },
    onError: (err: unknown) => {
      const mapped = mapFieldErrors(err);
      setFieldErrors(mapped);
      setFormError(
        Object.keys(mapped).length > 0
          ? null
          : err instanceof ApiError
            ? err.message
            : "Create failed",
      );
    },
  });

  const fields = useMemo(() => SOURCE_FIELDS[source], [source]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Import Requirements</h1>
        <p className="text-sm text-muted-foreground">
          Pull issues from GitHub, Jira, Azure DevOps, or Linear into this project as requirements.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New import</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="source">Source</Label>
            <select
              id="source"
              aria-label="Source"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={source}
              onChange={(e) => {
                setSource(e.target.value as ImportSourceKind);
                setPreview(null);
                setFilter({});
              }}
            >
              {IMPORT_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="label">Label</Label>
            <Input
              id="label"
              value={label}
              placeholder={`${SOURCE_LABELS[source]} import`}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          {fields.map((field) => {
            const fieldError = fieldErrors[field.key];
            return (
              <div key={field.key}>
                <Label htmlFor={field.key}>{field.label}</Label>
                <Input
                  id={field.key}
                  value={filter[field.key] ?? ""}
                  placeholder={field.placeholder}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={fieldError ? `${field.key}-error` : undefined}
                  onChange={(e) => {
                    const value = e.target.value;
                    setFilter((prev) => ({ ...prev, [field.key]: value }));
                    setFieldErrors((prev) => {
                      if (!prev[field.key]) return prev;
                      const { [field.key]: _omit, ...rest } = prev;
                      return rest;
                    });
                  }}
                />
                {fieldError ? (
                  <p id={`${field.key}-error`} role="alert" className="mt-1 text-xs text-red-600">
                    {fieldError}
                  </p>
                ) : null}
              </div>
            );
          })}

          {usesToken && (
            <div>
              <Label htmlFor="token">API token</Label>
              <Input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
          )}

          {usesToken && (
            <div>
              <Label htmlFor="baseUrl">Base URL (optional, self-hosted)</Label>
              <Input id="baseUrl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </div>
          )}

          {formError && <p className="text-sm text-red-600">{formError}</p>}

          <div className="flex gap-2">
            <Button
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
              variant="outline"
            >
              {previewMutation.isPending ? "Previewing…" : "Preview"}
            </Button>
            <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Starting…" : "Import"}
            </Button>
          </div>

          {activeProgress && !activeProgress.done && (
            // #662 — SC 2.2.2 Pause, Stop, Hide. A running import streams
            // progress into this live region until it completes; expose a
            // keyboard-operable control to pause the updates + silence
            // announcements. It renders only while the import is in flight.
            <PausableLiveRegion label="Import progress" testId="import-active-progress">
              <JobProgress
                progress={activeProgress.progress}
                message={activeProgress.message}
                indeterminate={activeProgress.indeterminate}
                label="Import progress"
                testId="import-progress"
              />
            </PausableLiveRegion>
          )}

          {preview && (
            <div className="rounded-md border p-4">
              <p className="text-sm font-medium">
                {preview.count} matching issue{preview.count === 1 ? "" : "s"} · showing first{" "}
                {preview.sample.length}
              </p>
              <ul className="mt-2 space-y-1">
                {preview.sample.map((s) => (
                  <li key={s.externalId} className="flex items-center gap-2 text-sm">
                    <Badge variant="outline">{s.type}</Badge>
                    <span className="truncate">{s.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <ImportHistory
        projectId={projectId}
        sources={sources.data ?? []}
        loading={sources.isLoading}
        confirmDeleteId={confirmDeleteId}
        onRequestDelete={setConfirmDeleteId}
        onRunStarted={setActiveRunId}
      />
    </div>
  );
}

function ImportHistory({
  projectId,
  sources,
  loading,
  confirmDeleteId,
  onRequestDelete,
  onRunStarted,
}: {
  projectId: string;
  sources: ImportSourceView[];
  loading: boolean;
  confirmDeleteId: string | null;
  onRequestDelete: (id: string | null) => void;
  /** #424 — surface the kicked-off run id so the page streams its progress. */
  onRunStarted: (runId: string) => void;
}) {
  const qc = useQueryClient();

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: queryKeys.imports.sources(projectId) });

  const syncMutation = useMutation({
    mutationFn: ({ id, enabled, interval }: { id: string; enabled: boolean; interval: number }) =>
      importApi.setSync(projectId, id, { syncEnabled: enabled, syncIntervalMinutes: interval }),
    onSuccess: invalidate,
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => importApi.runSource(projectId, id),
    onSuccess: (run) => {
      // #424 — track the manual run so live progress + the terminal toast fire.
      onRunStarted(run.id);
      invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => importApi.deleteSource(projectId, id),
    onSuccess: () => {
      onRequestDelete(null);
      invalidate();
    },
  });

  if (loading) return <p className="text-sm text-muted-foreground">Loading import history…</p>;
  if (sources.length === 0) return <p className="text-sm text-muted-foreground">No imports yet.</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {sources.map((s) => (
          <div key={s.id} className="rounded-md border p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="font-medium">{s.label}</p>
                <p className="text-xs text-muted-foreground">
                  {SOURCE_LABELS[s.source]}
                  {s.lastRun ? ` · last run: ${s.lastRun.status}` : ""}
                  {s.disabledReason ? ` · ${s.disabledReason}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {s.lastRun && (
                  <Badge variant={s.lastRun.status === "failed" ? "destructive" : "outline"}>
                    +{s.lastRun.createdCount}/~{s.lastRun.updatedCount}
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => runMutation.mutate(s.id)}
                  disabled={runMutation.isPending}
                >
                  Run now
                </Button>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Ongoing sync for ${s.label}`}
                  checked={s.syncEnabled}
                  onChange={(e) =>
                    syncMutation.mutate({
                      id: s.id,
                      enabled: e.target.checked,
                      interval: s.syncIntervalMinutes,
                    })
                  }
                />
                Ongoing sync
              </label>
              <div className="flex items-center gap-1">
                <Label htmlFor={`interval-${s.id}`} className="text-xs">
                  every
                </Label>
                <Input
                  id={`interval-${s.id}`}
                  type="number"
                  className="h-8 w-20"
                  min={IMPORT_SYNC_MIN_INTERVAL_MINUTES}
                  defaultValue={s.syncIntervalMinutes}
                  disabled={!s.syncEnabled}
                  onBlur={(e) =>
                    syncMutation.mutate({
                      id: s.id,
                      enabled: s.syncEnabled,
                      interval: Number(e.target.value) || s.syncIntervalMinutes,
                    })
                  }
                />
                <span className="text-xs text-muted-foreground">min</span>
              </div>

              {confirmDeleteId === s.id ? (
                <span className="ml-auto flex items-center gap-2 text-sm">
                  Delete this import?
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => deleteMutation.mutate(s.id)}
                    disabled={deleteMutation.isPending}
                  >
                    Confirm
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onRequestDelete(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => onRequestDelete(s.id)}
                >
                  Delete
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
