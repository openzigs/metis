"use client";

/**
 * Live-publish confirmation — #1104 (D).
 *
 * Unchecking "Dry run" turned the primary button into "Publish now" and one
 * click fired it: during the verification walkthrough that created 14 issues in
 * a real GitHub repository, and GitHub issues cannot be deleted through the
 * normal API path. There was nothing to reject and nothing to read first.
 *
 * The design rule this follows: a confirmation must be *cheap and informative*,
 * not a chore. Requiring a dry run first would be safe and annoying, and people
 * route around annoying safeguards. So the dialog opens instantly with the two
 * facts that prevent the mistake it exists to prevent — the destination repo
 * (caller-supplied, so a typo here is the whole risk) and how many drafts are
 * selected — and fills in the exact action breakdown when the server's plan
 * arrives. The plan is a preview: it writes nothing, so it can be asked for on
 * every dialog open.
 *
 * The confirm button is deliberately NOT gated on the plan arriving. The plan
 * is information, not permission; a slow or failed preview must not become a
 * new way for the page to be unusable, and the user has still explicitly
 * confirmed a named destination.
 *
 * Lives in `components/` because the publish page is excluded from UI coverage.
 */
import type { DryRunPlan } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  credentialWarning,
  estimatedDurationLabel,
  summarizeDryRunPlan,
} from "@/components/publishing/dry-run-plan-panel";

export interface PublishConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the issues would be written. */
  target: { owner: string; repo: string };
  /** How many drafts the user has selected. */
  draftCount: number;
  /** The server-computed plan, once it has arrived. */
  plan: DryRunPlan | null;
  planLoading: boolean;
  planError: unknown;
  /** True while the publish request itself is in flight. */
  pending: boolean;
  onConfirm: () => void;
}

export function PublishConfirmDialog({
  open,
  onOpenChange,
  target,
  draftCount,
  plan,
  planLoading,
  planError,
  pending,
  onConfirm,
}: PublishConfirmDialogProps) {
  const repo = `${target.owner}/${target.repo}`;
  const summary = plan ? summarizeDryRunPlan(plan) : [];
  const credential = plan ? credentialWarning(plan) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish to {repo}?</DialogTitle>
        </DialogHeader>

        <p
          className="mt-2 rounded bg-red-50 p-2 text-sm text-red-800"
          data-testid="publish-confirm-irreversible"
        >
          This writes to GitHub. Issues created here cannot be deleted from Metis — they can only be
          closed. Check the repository name before continuing.
        </p>

        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-slate-500">Repository</dt>
            <dd className="font-mono font-medium" data-testid="publish-confirm-target">
              {repo}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-slate-500">Drafts selected</dt>
            <dd className="font-medium" data-testid="publish-confirm-selection">
              {draftCount}
            </dd>
          </div>
        </dl>

        <div className="mt-3" data-testid="publish-confirm-summary">
          {plan ? (
            <>
              <p className="text-sm font-medium" data-testid="publish-confirm-total">
                {plan.totalActions} action{plan.totalActions === 1 ? "" : "s"} · estimated{" "}
                {estimatedDurationLabel(plan)}
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {summary.map((s) => (
                  <li
                    key={s.kind}
                    className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                  >
                    {s.kind} × {s.count}
                  </li>
                ))}
              </ul>
            </>
          ) : planLoading ? (
            <p className="text-sm text-slate-500">Working out what will be written…</p>
          ) : (
            <p className="text-sm text-amber-800">
              {planError
                ? "Could not compute the plan for this batch. The publish will still run exactly as configured above — continue only if the repository is right."
                : "No plan available for this batch."}
            </p>
          )}
        </div>

        {credential && (
          <p
            className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800"
            data-testid="publish-confirm-credential"
          >
            {credential}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? "Publishing…" : `Publish to ${repo}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
