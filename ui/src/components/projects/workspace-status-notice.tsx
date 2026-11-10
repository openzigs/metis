"use client";

/**
 * #2208 — why a create form's Create button is disabled while the caller's
 * workspaces are unread. Until they are read the active workspace is unknown,
 * and creating then would put the project in no workspace without a word.
 * Renders nothing once the workspaces are read.
 */
import { Button } from "@/components/ui/button";
import type { ActiveWorkspaceStatus } from "@/lib/active-workspace";

export interface WorkspaceStatusNoticeProps {
  status: ActiveWorkspaceStatus;
  /** Re-read the workspaces after an error. */
  onRetry?: () => void;
}

export function WorkspaceStatusNotice({ status, onRetry }: WorkspaceStatusNoticeProps) {
  if (status === "ready") return null;
  if (status === "loading") {
    return (
      <p role="status" className="text-xs text-muted-foreground" data-testid="workspace-status">
        Loading your workspaces…
      </p>
    );
  }
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 text-sm text-destructive"
      data-testid="workspace-status"
    >
      <span>
        Your workspaces could not be loaded, so the project has no workspace to go in yet.
      </span>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
