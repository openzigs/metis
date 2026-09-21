"use client";

/**
 * Epic #852 (#858) — database-aware analysis settings card on project Settings.
 *
 * Surfaces the per-project `databaseAwareAnalysis` intent (`auto`/`on`/`off`)
 * via `GET|PATCH /api/projects/:id/database-aware-analysis` (#857), which reads
 * through the SAME resolver the run path (#855) and gap-report path (#856)
 * consume — this card can never drift from what actually happens on a run.
 *
 * Follows the `InferenceProfileCard` self-fetching pattern (own `useQuery`,
 * `useEffect`-synced draft, dirty-state Save + 2s Saved toast) since the
 * resolved state (`enabled`/`ran`/`reason`/`hasSchemaData`) is not part of the
 * base `Project` object the parent page already holds.
 *
 * When the resolved decision is on/auto but no schema data exists yet
 * (`reason` is `skipped-no-schema-data` or `auto->resolved-off-no-data`), an
 * actionable hint links to the Connections tab — the SAME route that hosts
 * both "connect a database" (`DatabaseResourceManager`) and the repo
 * re-ingest actions ("Refresh ingest" / "Deep ingest"), so one link covers
 * both remediation paths named in the acceptance criteria.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DatabaseAwareAnalysisSetting } from "@metis/shared";
import { DATABASE_AWARE_ANALYSIS_SETTINGS } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { projectsApi, type DatabaseAwareAnalysisState } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { useTransientFlag } from "@/hooks/use-transient-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
}

const OPTION_HINTS: Record<DatabaseAwareAnalysisSetting, string> = {
  auto: "Auto (default) — enables database-aware analysis automatically when the project has a connected database or a schema graph.",
  on: "On — always run database-aware analysis for this project (explicit override).",
  off: "Off — never run database-aware analysis for this project (explicit override).",
};

const NO_SCHEMA_DATA_REASONS: ReadonlySet<DatabaseAwareAnalysisState["reason"]> = new Set([
  "skipped-no-schema-data",
  "auto->resolved-off-no-data",
]);

function resolvedStateCopy(state: DatabaseAwareAnalysisState): string {
  if (state.enabled && state.ran) {
    return state.reason === "auto->resolved-on"
      ? "Currently ON — a connected database or schema graph was detected."
      : "Currently ON (explicit override).";
  }
  if (state.enabled && !state.ran) {
    return "Currently ON, but not running yet — no schema data available.";
  }
  if (state.reason === "auto->resolved-off-no-data") {
    return "Currently OFF — will activate automatically once a database is connected or a schema graph exists.";
  }
  // #849 — an administrator disabled database-aware analysis for the whole
  // deployment. Say so, rather than implying this project opted out; choosing
  // "On" here still overrides it.
  if (state.reason === "auto->platform-disabled") {
    return "Currently OFF — disabled by platform configuration. Choose “On” to override it for this project.";
  }
  return "Currently OFF (explicit override).";
}

function showsNoSchemaDataHint(state: DatabaseAwareAnalysisState): boolean {
  return !state.hasSchemaData && NO_SCHEMA_DATA_REASONS.has(state.reason);
}

export function DatabaseAwareAnalysisSettingsCard({ projectId }: Props) {
  const qc = useQueryClient();
  const queryKey = queryKeys.projects.databaseAwareAnalysis(projectId);

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => projectsApi.getDatabaseAwareAnalysis(projectId),
    enabled: Boolean(projectId),
  });

  const [draft, setDraft] = useState<DatabaseAwareAnalysisSetting>("auto");
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
    mutationFn: (databaseAwareAnalysis: DatabaseAwareAnalysisSetting) =>
      projectsApi.updateDatabaseAwareAnalysis(projectId, { databaseAwareAnalysis }),
    onSuccess: () => {
      setFormError(null);
      showSavedToast();
      qc.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      clearSavedToast();
      setFormError(
        err instanceof ApiError ? err.message : "Failed to save database-aware analysis setting",
      );
    },
  });

  return (
    <section
      className="space-y-3 rounded-md border p-4"
      data-testid="database-aware-analysis-settings-card"
      aria-labelledby="database-aware-analysis-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="database-aware-analysis-heading" className="text-sm font-semibold">
            Database-aware analysis
          </h3>
          <p className="text-xs text-muted-foreground">
            Controls whether analysis runs cross-reference the database schema graph — both the
            run-side prompts and the gap-report&apos;s database-changes section move together.
          </p>
        </div>
        {savedToast ? (
          <span
            role="status"
            aria-live="polite"
            className="rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-900"
            data-testid="database-aware-analysis-saved-toast"
          >
            Saved
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="database-aware-analysis-loading">
          Loading database-aware analysis setting…
        </p>
      ) : error || !data ? (
        <p
          className="text-sm text-destructive"
          role="alert"
          data-testid="database-aware-analysis-load-error"
        >
          Failed to load database-aware analysis setting.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="database-aware-analysis-select">Mode</Label>
              <select
                id="database-aware-analysis-select"
                data-testid="database-aware-analysis-select"
                className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                value={draft}
                onChange={(e) => setDraft(e.target.value as DatabaseAwareAnalysisSetting)}
              >
                {DATABASE_AWARE_ANALYSIS_SETTINGS.map((s) => (
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
              data-testid="database-aware-analysis-save-button"
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="database-aware-analysis-hint">
            {OPTION_HINTS[draft]}
          </p>
          <p className="text-xs font-medium" data-testid="database-aware-analysis-resolved-state">
            {resolvedStateCopy(data)}
          </p>
          {showsNoSchemaDataHint(data) ? (
            <p
              className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
              role="status"
              data-testid="database-aware-analysis-no-schema-data-hint"
            >
              No schema data yet — connect a database or re-ingest to enable schema-impact analysis.{" "}
              <Link
                href={`/projects/${projectId}/connections`}
                className="underline"
                data-testid="database-aware-analysis-connect-link"
              >
                Connect a database or re-ingest →
              </Link>
            </p>
          ) : null}
          {formError ? (
            <p
              className="text-sm text-destructive"
              role="alert"
              data-testid="database-aware-analysis-error"
            >
              {formError}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
