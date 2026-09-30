"use client";

/**
 * #18 — say plainly what a chat answer is based on.
 *
 * Retrieval runs only for a chat bound to one project. With the scope on "All
 * projects" the model answers from its own knowledge — and before #18 nothing
 * on screen said so, so a confident answer naming files that do not exist read
 * like one drawn from the user's code.
 */
import type { ChatGrounding } from "@/lib/ai-client";

export function groundingText(g: ChatGrounding): string {
  switch (g.status) {
    case "grounded":
      return `Grounded in ${g.projectName} · ${g.sources} ${g.sources === 1 ? "source" : "sources"}`;
    case "no-context":
      return `Not grounded — nothing relevant was found in ${g.projectName}; answered from the model's general knowledge`;
    case "unscoped":
      return "Not grounded — no project selected; answered from the model's general knowledge";
  }
}

/** Under each assistant reply: what that reply was grounded in. */
export function GroundingBadge({ grounding }: { grounding: ChatGrounding | undefined }) {
  if (!grounding) return null;
  const grounded = grounding.status === "grounded";
  return (
    <p
      data-testid="chat-grounding"
      data-grounding={grounding.status}
      className={`mt-1 text-xs ${grounded ? "text-muted-foreground" : "text-warning"}`}
    >
      {groundingText(grounding)}
    </p>
  );
}

/**
 * Above the transcript, before anything is sent: the session has no project,
 * so no retrieval will run. Shown from the session the server actually created
 * (its `projectId`), not from the picker's value, so it cannot disagree with
 * what the turn will do.
 */
export function UngroundedScopeNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p
      role="status"
      data-testid="chat-ungrounded-notice"
      className="rounded border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning"
    >
      &ldquo;All projects&rdquo; does not search your projects — answers come from the model&apos;s
      general knowledge, not your code or documents. Pick a project to ground answers in it.
    </p>
  );
}
