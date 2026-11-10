"use client";

/**
 * #2208 — why a create form's Create button is disabled while the caller's
 * workspaces are unread. Until they are read the active workspace is unknown,
 * and creating then would put the project in no workspace without a word.
 * Renders nothing once the workspaces are read.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ActiveWorkspaceStatus } from "@/lib/active-workspace";

export interface WorkspaceStatusNoticeProps {
  status: ActiveWorkspaceStatus;
  /** Re-read the workspaces after an error; a returned promise settles with the read. */
  onRetry?: () => unknown;
}

export function WorkspaceStatusNotice({ status, onRetry }: WorkspaceStatusNoticeProps) {
  // #2218 — Try again said nothing while it ran: it now reads "Trying again…",
  // disabled, until the re-read settles.
  const [retrying, setRetrying] = useState(false);
  if (status === "ready") return null;
  if (status === "loading") {
    return (
      <p role="status" className="text-xs text-muted-foreground" data-testid="workspace-status">
        Loading your workspaces…
      </p>
    );
  }
  const retry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void retry()}
          disabled={retrying}
          aria-busy={retrying}
        >
          {retrying ? "Trying again…" : "Try again"}
        </Button>
      ) : null}
    </div>
  );
}
