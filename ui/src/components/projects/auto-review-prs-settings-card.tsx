"use client";

/**
 * #1169 — automatic PR review switch on project Settings.
 *
 * `Project.autoReviewPrs` is the only gate the GitHub pull-request webhook
 * reads before it queues a review, and nothing could set it. The switch saves
 * on change through `PATCH /api/projects/:id` (`project.update`).
 *
 * A review only ever starts for a GitHub repository connected to this project,
 * so the switch is disabled — with the reason shown — until one is. It stays
 * switchable OFF if it is on and the repository has since gone.
 */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectsApi } from "@/lib/projects-api";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { queryKeys } from "@/lib/query-keys";

interface Props {
  projectId: string;
  enabled: boolean | undefined;
  /** The caller holds `project.update`, which the server requires. */
  canEdit: boolean;
}

/** Providers whose pull requests reach the GitHub webhook. */
const GITHUB_PROVIDERS = new Set(["github", "github_enterprise"]);

export function AutoReviewPrsSettingsCard({ projectId, enabled, canEdit }: Props) {
  const qc = useQueryClient();
  const [on, setOn] = useState(Boolean(enabled));
  const [error, setError] = useState<string | null>(null);

  const repos = useQuery({
    queryKey: ["connectors", "repos", projectId],
    queryFn: () => repoConnectorsApi.list(projectId),
    enabled: Boolean(projectId),
  });
  const hasGithubRepo = (repos.data ?? []).some((r) => GITHUB_PROVIDERS.has(r.provider));

  const save = useMutation({
    mutationFn: (next: boolean) => projectsApi.update(projectId, { autoReviewPrs: next }),
    onSuccess: (project, next) => {
      setOn(project?.autoReviewPrs ?? next);
      setError(null);
      toast.success(next ? "Automatic PR review turned on" : "Automatic PR review turned off");
      qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error && err.message ? err.message : "Update failed");
    },
  });

  let reason: React.ReactNode = null;
  if (!canEdit) {
    reason = "You need permission to change this project's settings to switch this.";
  } else if (repos.isError) {
    reason = "Could not check this project's repositories. Reload the page to try again.";
  } else if (!repos.isLoading && !hasGithubRepo && !on) {
    reason = (
      <>
        Connect a GitHub repository to this project first, in{" "}
        <Link href={`/projects/${projectId}/connections`} className="underline">
          Connections
        </Link>
        .
      </>
    );
  }
  // Turning it off is never blocked on the repository check.
  const disabled = save.isPending || !canEdit || (!on && (repos.isLoading || reason !== null));

  return (
    <section
      className="space-y-3 rounded-md border p-4"
      data-testid="auto-review-prs-settings-card"
      aria-labelledby="auto-review-prs-heading"
    >
      <div>
        <h3 id="auto-review-prs-heading" className="text-sm font-semibold">
          Automatic PR review
        </h3>
        <p className="text-xs text-muted-foreground">
          When on, every pull request opened or updated in this project&apos;s connected GitHub
          repository is reviewed against the project&apos;s requirements, and the review is posted
          on the pull request. Each review spends model budget, so a busy repository costs more.
          GitHub must also be set up to send pull-request events to METIS (a webhook your
          administrator adds to the repository).
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          disabled={disabled}
          onChange={(e) => save.mutate(e.target.checked)}
          data-testid="auto-review-prs-toggle"
        />
        <span>Review pull requests automatically</span>
      </label>
      {reason ? (
        <p className="text-xs text-muted-foreground" data-testid="auto-review-prs-reason">
          {reason}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="auto-review-prs-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
