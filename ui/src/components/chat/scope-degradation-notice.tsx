"use client";

/**
 * Issue #607 — visible feedback when the server degraded the requested chat
 * project scope. POST /ai/sessions echoes `scope` metadata; whenever the
 * applied scope differs from what the user asked for (2+ projects selected,
 * or a stale project id), this banner explains that the session is running
 * unscoped so the user is never silently ungrounded.
 */
import type { SessionScope } from "@/lib/ai-client";

function noticeText(scope: SessionScope): string {
  switch (scope.reason) {
    case "multi-project-unsupported": {
      const n = scope.requestedProjectIds.length;
      return `Chat supports a single project scope — your ${n} selected projects were not applied and this session is unscoped. Pick one project to ground the conversation.`;
    }
    case "stale-project":
      return "The selected project is no longer available — this session is unscoped.";
    default:
      return "The requested project scope could not be applied — this session is unscoped.";
  }
}

export function ScopeDegradationNotice({ scope }: { scope: SessionScope | null }) {
  if (!scope?.degraded) return null;
  return (
    <div
      role="status"
      data-testid="scope-degradation-notice"
      className="rounded border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
    >
      {noticeText(scope)}
    </div>
  );
}
