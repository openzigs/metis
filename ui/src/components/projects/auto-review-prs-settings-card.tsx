"use client";

/**
 * #1169 — automatic PR review switch and its monthly limit, on project Settings.
 *
 * `Project.autoReviewPrs` is the only gate the GitHub pull-request webhook
 * reads before it queues a review, and nothing could set it. The switch saves
 * on change through `PATCH /api/projects/:id` (`project.update`).
 *
 * A review only ever starts for a GitHub repository connected to this project,
 * so the switch is disabled — with the reason shown — until one is. It stays
 * switchable OFF if it is on and the repository has since gone.
 *
 * `Project.prReviewMonthlyBudgetCents` is the only cap on what those reviews
 * spend (`checkBudget`, `lib/agents/pr-reviewer/budget-guard.ts`). It is set
 * here in dollars, next to this month's spend from
 * `GET /api/projects/:id/pr-review-budget`; empty means no limit.
 */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectsApi } from "@/lib/projects-api";
import { PR_REVIEW_UNPRICED_LIMIT_TEXT, prReviewLimitIsSet } from "@/lib/pr-review-copy";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
  enabled: boolean | undefined;
  /** Saved monthly limit in cents; null/undefined = no limit. */
  monthlyBudgetCents?: number | null;
  /** The caller holds `project.update`, which the server requires. */
  canEdit: boolean;
}

/** Providers whose pull requests reach the GitHub webhook. */
const GITHUB_PROVIDERS = new Set(["github", "github_enterprise"]);

/** Mirrors `PR_REVIEW_MONTHLY_BUDGET_MAX_CENTS` in `@metis/shared`. */
const MAX_LIMIT_CENTS = 10_000_000;

function centsToField(c: number | null | undefined): string {
  return c == null ? "" : (c / 100).toFixed(2);
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Empty → null (no limit); otherwise whole cents, or an error to show. */
function parseLimit(raw: string): number | null | { error: string } {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s);
  const cents = Math.round(n * 100);
  if (!Number.isFinite(n) || cents < 1) {
    return { error: "Enter an amount of at least $0.01, or leave it empty for no limit." };
  }
  if (cents > MAX_LIMIT_CENTS) {
    return { error: `The limit can be at most ${formatUsd(MAX_LIMIT_CENTS)} a month.` };
  }
  return cents;
}

export function AutoReviewPrsSettingsCard({
  projectId,
  enabled,
  monthlyBudgetCents,
  canEdit,
}: Props) {
  const qc = useQueryClient();
  const [on, setOn] = useState(Boolean(enabled));
  const [error, setError] = useState<string | null>(null);
  const [savedLimit, setSavedLimit] = useState(centsToField(monthlyBudgetCents));
  const [draftLimit, setDraftLimit] = useState(savedLimit);
  const [limitError, setLimitError] = useState<string | null>(null);

  const repos = useQuery({
    queryKey: ["connectors", "repos", projectId],
    queryFn: () => repoConnectorsApi.list(projectId),
    enabled: Boolean(projectId),
  });
  const hasGithubRepo = (repos.data ?? []).some((r) => GITHUB_PROVIDERS.has(r.provider));

  const budget = useQuery({
    queryKey: queryKeys.projects.prReviewBudget(projectId),
    queryFn: () => projectsApi.getPrReviewBudget(projectId),
    enabled: Boolean(projectId),
  });

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

  const saveLimit = useMutation({
    mutationFn: () => {
      const parsed = parseLimit(draftLimit);
      if (parsed !== null && typeof parsed === "object") throw new Error(parsed.error);
      return projectsApi.update(projectId, { prReviewMonthlyBudgetCents: parsed });
    },
    onSuccess: () => {
      setSavedLimit(draftLimit.trim() === "" ? "" : centsToField(parseLimit(draftLimit) as number));
      setLimitError(null);
      toast.success("Monthly limit saved");
      qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    },
    onError: (err: unknown) => {
      setLimitError(err instanceof Error && err.message ? err.message : "Update failed");
    },
  });
  const limitDirty = draftLimit.trim() !== savedLimit;

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
          Without a monthly limit there is no cap on this spend. GitHub must also be set up to send
          pull-request events to METIS (a webhook your administrator adds to the repository).
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

      <div className="space-y-1">
        <Label htmlFor="auto-review-prs-limit">Monthly limit for automatic PR reviews (USD)</Label>
        <div className="flex items-end gap-2">
          <Input
            id="auto-review-prs-limit"
            data-testid="auto-review-prs-limit-input"
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={draftLimit}
            disabled={!canEdit}
            onChange={(e) => setDraftLimit(e.target.value)}
            placeholder="No limit"
          />
          <Button
            type="button"
            size="sm"
            onClick={() => saveLimit.mutate()}
            disabled={!canEdit || !limitDirty || saveLimit.isPending}
            data-testid="auto-review-prs-limit-save"
          >
            {saveLimit.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Leave it empty for no limit. Once a month&apos;s reviews reach the limit, new pull
          requests are not reviewed until the next month starts.
        </p>
        {limitError ? (
          <p
            className="text-sm text-destructive"
            role="alert"
            data-testid="auto-review-prs-limit-error"
          >
            {limitError}
          </p>
        ) : null}
        {budget.data ? (
          <p className="text-xs text-muted-foreground" data-testid="auto-review-prs-spend">
            Spent on automatic PR reviews this month: {formatUsd(budget.data.spentCents)}
            {prReviewLimitIsSet(budget.data.capCents)
              ? ` of ${formatUsd(budget.data.capCents)}.`
              : " (no limit)."}
          </p>
        ) : null}
        {budget.data && !budget.data.allowed ? (
          <p
            className="rounded border border-warning/40 bg-warning-muted p-2 text-xs text-warning"
            role="alert"
            data-testid="auto-review-prs-limit-reached"
          >
            This month&apos;s limit is reached, so new pull requests are not being reviewed. Reviews
            resume on {new Date(budget.data.resetAt).toLocaleDateString()}, or sooner if you raise
            the limit.
          </p>
        ) : null}
        {budget.data &&
        prReviewLimitIsSet(budget.data.capCents) &&
        budget.data.modelPriced === false ? (
          <p
            className="rounded border border-warning/40 bg-warning-muted p-2 text-xs text-warning"
            role="alert"
            data-testid="auto-review-prs-unpriced"
          >
            {PR_REVIEW_UNPRICED_LIMIT_TEXT}
          </p>
        ) : null}
      </div>
    </section>
  );
}
