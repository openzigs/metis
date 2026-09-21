"use client";

/**
 * Epic #882 (#894) — SQL-lineage settings card on project Settings.
 *
 * Surfaces the per-project `sqlLineage` intent (`auto`/`on`/`off`) via
 * `GET|PATCH /api/projects/:id/sql-lineage`, which reads through the SAME
 * resolver the ingest wiring (`buildCodeGraphSchemaWiring`, `db-service.ts`)
 * consumes — this card can never drift from what actually happens on ingest.
 *
 * Follows the `DatabaseAwareAnalysisSettingsCard` self-fetching pattern (own
 * `useQuery`, `useEffect`-synced draft, dirty-state Save + 2s Saved toast)
 * since the resolved state (`enabled`/`reason`/`sidecarConfigured`) is not
 * part of the base `Project` object the parent page already holds.
 *
 * When the resolved decision is enabled but `sidecarConfigured` is false, an
 * actionable hint explains that the `metis-sql-lineage` sidecar's shared
 * secret (`SQL_LINEAGE_TOKEN`) is not configured — so enabling this setting
 * without the sidecar shows a clear state rather than a silent no-op (#894
 * acceptance criterion).
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SqlLineageSetting } from "@metis/shared";
import { SQL_LINEAGE_SETTINGS } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { projectsApi, type SqlLineageState } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { useTransientFlag } from "@/hooks/use-transient-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
}

const OPTION_HINTS: Record<SqlLineageSetting, string> = {
  auto: "Auto (default) — defers to the platform default (SQL_LINEAGE_MODE=sidecar).",
  on: "On — always attempt SQL-lineage extraction for this project (explicit override).",
  off: "Off — never attempt SQL-lineage extraction for this project (explicit override).",
};

function resolvedStateCopy(state: SqlLineageState): string {
  if (!state.enabled) {
    return state.reason === "auto->platform-disabled"
      ? "Currently OFF — the platform default (SQL_LINEAGE_MODE) is not set to sidecar."
      : "Currently OFF (explicit override).";
  }
  if (!state.sidecarConfigured) {
    return "Currently ON, but the metis-sql-lineage sidecar looks unconfigured.";
  }
  return state.reason === "auto->platform-enabled"
    ? "Currently ON — the platform default (SQL_LINEAGE_MODE=sidecar) is active."
    : "Currently ON (explicit override).";
}

export function SqlLineageSettingsCard({ projectId }: Props) {
  const qc = useQueryClient();
  const queryKey = queryKeys.projects.sqlLineage(projectId);

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => projectsApi.getSqlLineage(projectId),
    enabled: Boolean(projectId),
  });

  const [draft, setDraft] = useState<SqlLineageSetting>("auto");
  // #1284 — the hook owns the 2s dismissal timer AND cancels it on unmount.
  const {
    active: savedToast,
    show: showSavedToast,
    clear: clearSavedToast,
  } = useTransientFlag(2000);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.setting) setDraft(data.setting);
  }, [data]);

  const dirty = data ? draft !== data.setting : false;

  const save = useMutation({
    mutationFn: (sqlLineage: SqlLineageSetting) =>
      projectsApi.updateSqlLineage(projectId, { sqlLineage }),
    onSuccess: () => {
      setFormError(null);
      showSavedToast();
      qc.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      clearSavedToast();
      setFormError(err instanceof ApiError ? err.message : "Failed to save SQL-lineage setting");
    },
  });

  return (
    <section
      className="space-y-3 rounded-md border p-4"
      data-testid="sql-lineage-settings-card"
      aria-labelledby="sql-lineage-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="sql-lineage-heading" className="text-sm font-semibold">
            SQL lineage
          </h3>
          <p className="text-xs text-muted-foreground">
            Controls whether ingest extracts embedded SQL / SAS PROC SQL / routine bodies / Tier-1
            catalog dependencies via the metis-sql-lineage sidecar.
          </p>
        </div>
        {savedToast ? (
          <span
            role="status"
            aria-live="polite"
            className="rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-900"
            data-testid="sql-lineage-saved-toast"
          >
            Saved
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="sql-lineage-loading">
          Loading SQL-lineage setting…
        </p>
      ) : error || !data ? (
        <p className="text-sm text-destructive" role="alert" data-testid="sql-lineage-load-error">
          Failed to load SQL-lineage setting.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="sql-lineage-select">Mode</Label>
              <select
                id="sql-lineage-select"
                data-testid="sql-lineage-select"
                className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                value={draft}
                onChange={(e) => setDraft(e.target.value as SqlLineageSetting)}
              >
                {SQL_LINEAGE_SETTINGS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => save.mutate(draft)}
              disabled={!dirty || save.isPending}
              data-testid="sql-lineage-save-button"
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="sql-lineage-hint">
            {OPTION_HINTS[draft]}
          </p>
          <p className="text-xs font-medium" data-testid="sql-lineage-resolved-state">
            {resolvedStateCopy(data)}
          </p>
          {data.enabled && !data.sidecarConfigured ? (
            <p
              className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
              role="status"
              data-testid="sql-lineage-sidecar-unconfigured-hint"
            >
              The metis-sql-lineage sidecar requires SQL_LINEAGE_TOKEN to be configured — ask an
              operator to set it, or extraction will silently produce no lineage edges.
            </p>
          ) : null}
          {formError ? (
            <p className="text-sm text-destructive" role="alert" data-testid="sql-lineage-error">
              {formError}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
