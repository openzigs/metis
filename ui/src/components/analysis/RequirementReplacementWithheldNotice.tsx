"use client";

/**
 * Issue #769 — say when a re-synthesis was NOT allowed to replace the
 * requirement set.
 *
 * Regenerate on one agent re-runs synthesis in the background. Before #769 that
 * re-synthesis hard-deleted the reviewed set (approvals, edits, links, data
 * mappings, baseline pins) minutes later, with nothing on screen. The server now
 * refuses that replacement and records why; this notice is where the user reads
 * it, so a Regenerate that changed no requirements is explained.
 *
 * Issue #780 — and gives the analyst a way forward: when the refused result was
 * kept, **Review changes** compares it with the current requirements,
 * **Apply changes** (after a confirmation naming every reviewed requirement it
 * rewords) writes it without deleting any review work, and **Dismiss changes**
 * (after a confirmation) keeps the current requirements as they are. Both
 * answers are offered only to `project.update` holders and only once the
 * comparison is open; Apply sends the comparison's fingerprint, so a
 * requirement changed since is never written unconfirmed.
 */
import * as React from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  describeRequirementReplacementWithheld,
  type RequirementReplacementWithheld,
  type WithheldReplacementDiff,
  type WithheldReplacementEntry,
  type WithheldReplacementField,
} from "@metis/shared";
import { Button } from "@/components/ui/button";
import {
  ConfirmDialog,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { analysisApi } from "@/lib/analysis-api";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useAppMutation } from "@/lib/use-app-mutation";

/**
 * Read the key directly (not through `readEnhancementMetadata`): like
 * `SynthesisDegradedNotice`, this renders on every analysis view, and the
 * page-level suites replace `@/lib/analysis-api` wholesale.
 */
function readWithheld(
  metadata: Record<string, unknown> | null | undefined,
): RequirementReplacementWithheld | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as { requirementReplacementWithheld?: unknown })
    .requirementReplacementWithheld;
  return value && typeof value === "object" ? (value as RequirementReplacementWithheld) : undefined;
}

export interface RequirementReplacementWithheldNoticeProps {
  metadata: Record<string, unknown> | null | undefined;
  /** #780 — needed for the Review / Apply / Dismiss actions. */
  projectId?: string;
  analysisId?: string;
  /** Refreshed once the analyst applies or dismisses. */
  invalidateKeys?: QueryKey[];
}

export function RequirementReplacementWithheldNotice({
  metadata,
  projectId,
  analysisId,
  invalidateKeys = [],
}: RequirementReplacementWithheldNoticeProps): React.ReactElement | null {
  const withheld = readWithheld(metadata);
  if (!withheld) return null;
  const actionable = Boolean(withheld.proposalStored && projectId && analysisId);

  return (
    <div
      data-testid="requirement-replacement-withheld"
      className="rounded border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning"
    >
      <p role="status">
        <span aria-hidden>⚠</span> {describeRequirementReplacementWithheld(withheld)}
      </p>
      {actionable ? (
        <WithheldReplacementActions
          withheld={withheld}
          projectId={projectId!}
          analysisId={analysisId!}
          invalidateKeys={invalidateKeys}
        />
      ) : null}
    </div>
  );
}

const FIELD_LABEL: Record<WithheldReplacementField, string> = {
  title: "Title",
  description: "Description",
  priority: "Priority",
  type: "Type",
  acceptanceCriteria: "Acceptance criteria",
};

const STATUS_LABEL: Record<string, string> = {
  approved: "Approved",
  rejected: "Rejected",
  deferred: "Deferred",
  draft: "Draft",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Approved" / "Has review work" / "Not reviewed", for a current requirement. */
function reviewLabel(entry: WithheldReplacementEntry): string {
  if (!entry.reviewed) return "Not reviewed";
  const status = entry.reviewStatus ? STATUS_LABEL[entry.reviewStatus] : undefined;
  return status && entry.reviewStatus !== "draft" ? status : "Has review work";
}

function WithheldReplacementActions({
  withheld,
  projectId,
  analysisId,
  invalidateKeys,
}: {
  withheld: RequirementReplacementWithheld;
  projectId: string;
  analysisId: string;
  invalidateKeys: QueryKey[];
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [confirmingDismiss, setConfirmingDismiss] = React.useState(false);
  const [changedSinceReview, setChangedSinceReview] = React.useState(false);
  const queryClient = useQueryClient();
  const panelId = React.useId();
  const { user } = useAuth();
  // #780 — the server's gate for both answers; Review stays open to everyone
  // who can read the analysis.
  const canAnswer = user?.permissions.includes("project.update") ?? false;

  const diff = useQuery({
    queryKey: ["analyses", "withheld-replacement", analysisId, withheld.at],
    queryFn: () => analysisApi.getWithheldReplacement(projectId, analysisId),
    enabled: open,
    retry: false,
  });

  // Whatever the answer (or a 409 because a newer re-synthesis arrived), the
  // analysis must be re-read so the notice shows what is true now.
  const refresh = () => {
    for (const key of invalidateKeys) void queryClient.invalidateQueries({ queryKey: key });
  };

  const apply = useAppMutation({
    mutationFn: (fingerprint: string) =>
      analysisApi.applyWithheldReplacement(projectId, analysisId, withheld.at, fingerprint),
    successMessage: (r) =>
      `Applied the new requirements: ${r.added} added, ${r.updated + r.replaced} changed, ` +
      `${r.deleted} removed${r.kept > 0 ? `, ${r.kept} reviewed kept` : ""}`,
    onSuccess: () => {
      setConfirming(false);
      setChangedSinceReview(false);
      refresh();
    },
    onError: (error) => {
      setConfirming(false);
      // The requirements changed after the comparison was loaded: show the
      // current one, and say so, rather than applying what was not confirmed.
      if (error instanceof ApiError && error.code === "STALE") {
        setChangedSinceReview(true);
        void diff.refetch();
      }
      refresh();
    },
  });
  const dismiss = useAppMutation({
    mutationFn: () => analysisApi.dismissWithheldReplacement(projectId, analysisId, withheld.at),
    successMessage: "Kept your current requirements. The new result was discarded.",
    onSuccess: refresh,
    onError: refresh,
  });
  const busy = apply.isPending || dismiss.isPending;

  return (
    <div className="mt-2 space-y-2 text-foreground">
      <p className="text-xs text-muted-foreground">
        {canAnswer
          ? "You can see what the new result would change, then apply it or keep your current requirements. Applying never deletes review work."
          : "You can see what the new result would change."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={open ? "default" : "outline"}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide changes" : "Review changes"}
        </Button>
      </div>
      {open ? (
        <section
          id={panelId}
          aria-label="Changes the new result would make"
          className="space-y-3 rounded border border-border bg-background p-3"
        >
          {diff.isLoading ? <p className="text-xs">Loading the comparison…</p> : null}
          {diff.isError ? (
            <p className="text-xs text-destructive">
              The comparison could not be loaded. It may have been answered already; reload the
              page.
            </p>
          ) : null}
          {changedSinceReview ? (
            <p role="alert" className="text-xs text-warning">
              The requirements changed after you opened this comparison, so nothing was applied. The
              comparison below is up to date: review it again before applying.
            </p>
          ) : null}
          {diff.data ? (
            <>
              <WithheldReplacementComparison diff={diff.data} />
              {canAnswer ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={() => setConfirming(true)}>
                    Apply changes
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirmingDismiss(true)}
                  >
                    Dismiss changes
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Ask a project owner to apply or dismiss these changes.
                </p>
              )}
              <ApplyConfirmation
                diff={diff.data}
                open={confirming}
                onOpenChange={setConfirming}
                onConfirm={() => apply.mutate(diff.data!.fingerprint)}
              />
              <ConfirmDialog
                open={confirmingDismiss}
                onOpenChange={setConfirmingDismiss}
                title="Dismiss the new result?"
                description={
                  "Your current requirements stay exactly as they are. The new result is " +
                  "discarded and cannot be brought back; run Regenerate again to get a new one."
                }
                confirmLabel="Dismiss changes"
                onConfirm={() => dismiss.mutate()}
              />
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** One plain-language summary sentence of what applying does. */
export function summarizeWithheldReplacement(diff: WithheldReplacementDiff): string {
  const deleted = diff.removed.filter((e) => e.outcome === "delete").length;
  const kept = diff.removed.length - deleted;
  const parts = [
    `add ${plural(diff.added.length, "requirement", "requirements")}`,
    `change ${diff.changed.length}`,
    `remove ${deleted}`,
  ];
  let text = `Applying would ${parts.join(", ")}.`;
  if (kept > 0) {
    text += ` ${plural(kept, "reviewed requirement", "reviewed requirements")} the new result leaves out ${
      kept === 1 ? "is" : "are"
    } kept.`;
  }
  if (diff.unchangedCount > 0) {
    text += ` ${diff.unchangedCount} ${diff.unchangedCount === 1 ? "is" : "are"} unchanged.`;
  }
  return text;
}

function Value({ value }: { value: string | string[] }): React.ReactElement {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="italic text-muted-foreground">None</span>;
    return (
      <ul className="list-disc pl-4">
        {value.map((v, i) => (
          <li key={i}>{v}</li>
        ))}
      </ul>
    );
  }
  return <span className="whitespace-pre-wrap">{value}</span>;
}

function ReviewBadge({ entry }: { entry: WithheldReplacementEntry }): React.ReactElement {
  return (
    <span
      className={
        "rounded px-1.5 py-0.5 text-[11px] " +
        (entry.reviewed ? "bg-info-muted text-info" : "bg-muted text-muted-foreground")
      }
    >
      {reviewLabel(entry)}
    </span>
  );
}

export function WithheldReplacementComparison({
  diff,
}: {
  diff: WithheldReplacementDiff;
}): React.ReactElement {
  return (
    <div className="space-y-3 text-xs">
      <p className="font-medium">{summarizeWithheldReplacement(diff)}</p>

      {diff.added.length > 0 ? (
        <section aria-label="New requirements">
          <h4 className="mb-1 font-semibold">New requirements ({diff.added.length})</h4>
          <ul className="space-y-2">
            {diff.added.map((e, i) => (
              <li key={i} className="rounded border border-border p-2">
                <p className="font-medium">{e.title}</p>
                {e.proposed ? (
                  <>
                    <p className="text-muted-foreground">
                      Priority {e.proposed.priority} · {e.proposed.type}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">{e.proposed.description}</p>
                    {e.proposed.acceptanceCriteria.length > 0 ? (
                      <div className="mt-1">
                        <p className="font-medium">Acceptance criteria</p>
                        <Value value={e.proposed.acceptanceCriteria} />
                      </div>
                    ) : null}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {diff.changed.length > 0 ? (
        <section aria-label="Changed requirements">
          <h4 className="mb-1 font-semibold">Changed requirements ({diff.changed.length})</h4>
          <ul className="space-y-2">
            {diff.changed.map((e, i) => (
              <li key={i} className="rounded border border-border p-2">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {e.title} <ReviewBadge entry={e} />
                </p>
                <p className="text-muted-foreground">
                  {e.outcome === "update"
                    ? "Its review work is kept. The new wording is saved as a new version you can restore from History."
                    : "Replaced with the new version."}
                </p>
                <dl className="mt-1 space-y-1">
                  {e.changes.map((c) => (
                    <div key={c.field} className="grid gap-1 sm:grid-cols-[9rem_1fr_1fr]">
                      <dt className="font-medium">{FIELD_LABEL[c.field]}</dt>
                      <dd className="rounded bg-destructive/10 p-1">
                        <span className="block text-[10px] uppercase text-muted-foreground">
                          Current
                        </span>
                        <Value value={c.before} />
                      </dd>
                      <dd className="rounded bg-success-muted p-1">
                        <span className="block text-[10px] uppercase text-muted-foreground">
                          New
                        </span>
                        <Value value={c.after} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {diff.removed.length > 0 ? (
        <section aria-label="Not in the new result">
          <h4 className="mb-1 font-semibold">Not in the new result ({diff.removed.length})</h4>
          <ul className="space-y-1">
            {diff.removed.map((e, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.title}</span> <ReviewBadge entry={e} />
                <span className="text-muted-foreground">
                  {e.outcome === "keep"
                    ? "Kept, because it has review work."
                    : "Will be removed (no review work)."}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {diff.skipped.length > 0 ? (
        <section aria-label="Not restored">
          <h4 className="mb-1 font-semibold">Not restored ({diff.skipped.length})</h4>
          <ul className="space-y-1">
            {diff.skipped.map((e, i) => (
              <li key={i}>
                <span className="font-medium">{e.title}</span>{" "}
                <span className="text-muted-foreground">
                  Someone deleted this requirement. Applying will not bring it back.
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {diff.added.length + diff.changed.length + diff.removed.length === 0 ? (
        <p>The new result matches your current requirements.</p>
      ) : null}
    </div>
  );
}

function ApplyConfirmation({
  diff,
  open,
  onOpenChange,
  onConfirm,
}: {
  diff: WithheldReplacementDiff;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}): React.ReactElement {
  const reworded = diff.changed.filter((e) => e.outcome === "update");
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Apply the new requirements?</AlertDialogTitle>
          <AlertDialogDescription>
            {summarizeWithheldReplacement(diff)} Requirements without review work are replaced, as a
            normal re-run would. Nothing with review work is deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {reworded.length > 0 ? (
          <div className="text-sm">
            <p className="font-medium">
              {plural(reworded.length, "reviewed requirement gets", "reviewed requirements get")}{" "}
              the new wording, saved as a new version you can restore from History. Status, links
              and comments stay:
            </p>
            <ul className="mt-1 list-disc pl-5">
              {reworded.map((e, i) => (
                <li key={i}>
                  {e.title} ({reviewLabel(e)})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Apply changes</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
