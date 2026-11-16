"use client";

/**
 * #2567 (epic #2564) — the analysis depth card on project Settings: how deeply
 * impact analysis reads this project's code. Thorough is `explore`, Fast is
 * `fast`, and "Use the platform default" is `auto` (#2566's
 * `Project.codeExploration`, written by `PATCH /api/projects/:id/code-exploration`).
 *
 * The selection shown is always the server's: it is read from
 * `GET /api/projects/:id` (`codeExploration` and `codeExplorationResolved`),
 * through the settings page's own project query, and a failed save puts the
 * saved value back. With `auto` the card names the platform default the
 * server resolved, and names none when the server sent none.
 *
 * The copy is written for a business analyst and is tested to stay free of
 * implementation words. The measured gain is hedged to the product it was
 * measured on (#2560: Miniflux; neutral on the fixture portfolio).
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodeExplorationSetting, CodePassMode } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { REQUIRES_PROJECT_UPDATE } from "@/lib/permission-hints";
import { codeExplorationStateOf, projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { useTransientFlag } from "@/hooks/use-transient-toast";
import { Button } from "@/components/ui/button";

interface Props {
  projectId: string;
  /** The caller holds `project.update`, which the server requires to save. */
  canEdit: boolean;
}

/** The choices, in the order they are shown. */
export const ANALYSIS_DEPTH_OPTIONS: ReadonlyArray<{
  value: CodeExplorationSetting;
  label: string;
  description: string;
}> = [
  {
    value: "explore",
    label: "Thorough",
    description:
      "METIS reads the code the way a developer would before answering. On a real product we tested, it found about a fifth more of the files a change touches. It takes a few seconds longer per requirement and costs a little more.",
  },
  {
    value: "fast",
    label: "Fast",
    description: "METIS answers from its search index. It is quicker, but it misses more files.",
  },
  {
    value: "auto",
    label: "Use the platform default",
    description: "Follow the choice your administrator made for every project.",
  },
];

const MODE_LABEL: Record<CodePassMode, string> = { explore: "Thorough", fast: "Fast" };

export function CodeExplorationSettingsCard({ projectId, canEdit }: Props) {
  const qc = useQueryClient();
  // The settings page's own project query (same key and fetch): the card
  // reads its part with `select`, so the page sends one GET, not two.
  const queryKey = queryKeys.projects.detail(projectId);
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => projectsApi.get(projectId),
    select: codeExplorationStateOf,
    enabled: Boolean(projectId),
  });

  const [draft, setDraft] = useState<CodeExplorationSetting>("auto");
  const { active: savedToast, show: showSaved, clear: clearSaved } = useTransientFlag(2000);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(data.setting);
  }, [data]);

  const dirty = data ? draft !== data.setting : false;

  const save = useMutation({
    mutationFn: (codeExploration: CodeExplorationSetting) =>
      projectsApi.updateCodeExploration(projectId, { codeExploration }),
    onSuccess: () => {
      setFormError(null);
      showSaved();
      qc.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      clearSaved();
      // The saved choice stays on screen: the failed one was not stored.
      if (data) setDraft(data.setting);
      setFormError(
        err instanceof ApiError && err.message
          ? `The analysis depth was not saved: ${err.message}`
          : "The analysis depth was not saved. Try again.",
      );
    },
  });

  return (
    <section
      className="space-y-3 rounded-md border p-4"
      data-testid="code-exploration-settings-card"
      aria-labelledby="code-exploration-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="code-exploration-heading" className="text-sm font-semibold">
            Analysis depth
          </h3>
          <p className="text-xs text-muted-foreground">
            How deeply METIS reads this project&apos;s code when it works out what a change affects.
          </p>
        </div>
        {savedToast ? (
          <span
            role="status"
            aria-live="polite"
            className="rounded bg-success-muted px-2 py-1 text-xs text-success"
            data-testid="code-exploration-saved-toast"
          >
            Saved
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="code-exploration-loading">
          Loading the analysis depth…
        </p>
      ) : error || !data ? (
        <p
          className="text-sm text-destructive"
          role="alert"
          data-testid="code-exploration-load-error"
        >
          The analysis depth could not be loaded.
        </p>
      ) : (
        <div className="space-y-3">
          <fieldset className="space-y-2" disabled={!canEdit || save.isPending}>
            <legend className="sr-only">Analysis depth</legend>
            {ANALYSIS_DEPTH_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2 text-sm"
                data-testid={`code-exploration-option-${option.value}`}
              >
                <input
                  type="radio"
                  name={`code-exploration-${projectId}`}
                  value={option.value}
                  checked={draft === option.value}
                  onChange={() => setDraft(option.value)}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {/* No resolved default from the server: name none rather than guess one. */}
          {data.setting === "auto" && data.resolved ? (
            <p className="text-xs font-medium" data-testid="code-exploration-platform-default">
              Platform default: {MODE_LABEL[data.resolved.mode]}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            A repository whose files are not available on the server is always analysed with Fast.
          </p>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              onClick={() => save.mutate(draft)}
              disabled={!canEdit || !dirty || save.isPending}
              data-testid="code-exploration-save-button"
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            {!canEdit ? (
              <span
                className="text-xs text-muted-foreground"
                data-testid="code-exploration-permission-hint"
              >
                {REQUIRES_PROJECT_UPDATE}
              </span>
            ) : null}
          </div>
          {formError ? (
            <p
              className="text-sm text-destructive"
              role="alert"
              data-testid="code-exploration-error"
            >
              {formError}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
