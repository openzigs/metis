"use client";

/**
 * #1171 — confirm a live publish into a repository another project connects.
 *
 * The server refuses such a publish with `REPO_CROSS_PROJECT` until the caller
 * confirms. The page used to show only the refusal, whose text told a business
 * analyst to "pass confirmCrossProject=true" — an API flag the page offered no
 * way to set. This dialog is that confirmation; confirming retries the same
 * batch with the flag set by the page.
 *
 * The server names the other project only when the user may open it (and says
 * "another project" otherwise), so this renders exactly the names it is given
 * and never guesses one.
 *
 * Lives in `components/` because the publish page is excluded from UI coverage.
 */
import { ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface CrossProjectRefusal {
  /** `owner/repo`. */
  repo: string;
  /** Other projects the user may open; empty = name none. */
  projects: string[];
}

/** The refusal carried by a publish error, or null for any other error. */
export function extractCrossProjectRefusal(err: unknown): CrossProjectRefusal | null {
  if (!(err instanceof ApiError) || err.code !== "REPO_CROSS_PROJECT") return null;
  const details = (err.details ?? {}) as { repo?: unknown; projects?: unknown };
  const repo = typeof details.repo === "string" ? details.repo : "";
  const projects = Array.isArray(details.projects)
    ? details.projects.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  return { repo, projects };
}

/** "the project "A"", "the projects "A", "B"" or "another project". */
export function otherProjectsLabel(projects: readonly string[]): string {
  if (projects.length === 0) return "another project";
  if (projects.length === 1) return `the project “${projects[0]}”`;
  return `the projects ${projects.map((p) => `“${p}”`).join(", ")}`;
}

/**
 * #1171 — shown with a dry run's result when its target is connected to
 * another project: the dry run went ahead, and the live publish will ask.
 */
export function CrossProjectDryRunNotice({ notice }: { notice: CrossProjectRefusal }) {
  return (
    <p
      className="mt-2 text-xs text-warning"
      role="status"
      data-testid="cross-project-dry-run-notice"
    >
      <span className="font-mono">{notice.repo}</span> is already connected to{" "}
      {otherProjectsLabel(notice.projects)}. Publishing for real will ask you to confirm.
    </p>
  );
}

export interface CrossProjectConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refusal: CrossProjectRefusal | null;
  /** The target the form holds, used when the refusal does not name one. */
  fallbackRepo: string;
  pending: boolean;
  onConfirm: () => void;
}

export function CrossProjectConfirmDialog({
  open,
  onOpenChange,
  refusal,
  fallbackRepo,
  pending,
  onConfirm,
}: CrossProjectConfirmDialogProps) {
  const repo = refusal?.repo || fallbackRepo;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="cross-project-confirm">
        <DialogHeader>
          <DialogTitle>Publish to a repository another project uses?</DialogTitle>
        </DialogHeader>
        <p className="mt-2 text-sm" data-testid="cross-project-confirm-text">
          <span className="font-mono">{repo}</span> is already connected to{" "}
          {otherProjectsLabel(refusal?.projects ?? [])}. Issues published from this project will
          appear in that repository alongside its work.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Check the owner and repository if you did not mean to share it.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending} data-testid="cross-project-confirm-button">
            {pending ? "Publishing…" : "Publish anyway"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
