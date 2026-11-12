"use client";

/**
 * #18 — say plainly what a chat answer is based on.
 *
 * Retrieval runs for a chat bound to one project, or (#2238) scoped to several
 * products or a workspace. With the scope on "All projects" the model answers
 * from its own knowledge — and before #18 nothing on screen said so, so a
 * confident answer naming files that do not exist read like one drawn from the
 * user's code.
 */
import type { ChatGrounding } from "@/lib/ai-client";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function groundingText(g: ChatGrounding): string {
  switch (g.status) {
    case "grounded": {
      // #439 — `sources` are the excerpts auto-retrieval supplied (a fused code
      // symbol counts as one each); `toolReads` the tool lookups (code search,
      // and #464 the project's knowledge search) that returned some of the
      // project. Either may be the only one present.
      const parts: string[] = [];
      if (g.sources > 0) parts.push(plural(g.sources, "source", "sources"));
      if (g.toolReads) parts.push(plural(g.toolReads, "project lookup", "project lookups"));
      return [`Grounded in ${g.projectName}`, ...parts].join(" · ");
    }
    case "no-context":
      // #2241 — say why nothing was supplied, when the server said.
      if (g.reason === "insufficient-evidence") {
        const weak = g.belowFloor
          ? ` (${plural(g.belowFloor, "weak match", "weak matches")} set aside)`
          : "";
        return `Insufficient evidence — nothing in ${g.projectName} was relevant enough to this question${weak}; check any file or code it names`;
      }
      if (g.reason === "retrieval-failed") {
        return `Retrieval failed — ${g.projectName}'s knowledge base could not be searched for this reply; check any file or code it names`;
      }
      // PR #437 review: say only what is known. Auto-retrieval supplied no
      // excerpts, but the model may still have read the project through its
      // tools (code search, tree, MCP), so "answered from general knowledge"
      // would be false on screen.
      return `No excerpts from ${g.projectName} were retrieved automatically — check any file or code it names`;
    case "unscoped":
      return "Not grounded — no project selected; answered from the model's general knowledge";
    case "multi":
      return multiText(g);
  }
}

/**
 * #2238 — a multi-product reply: each product it searched, with how many of
 * its excerpts the answer drew on; the ones searched without a match; and,
 * by name, the ones that could not be searched this turn.
 */
function multiText(g: Extract<ChatGrounding, { status: "multi" }>): string {
  const parts: string[] = [];
  const used = g.projects.filter((p) => p.sources > 0);
  const unused = g.projects.filter((p) => p.sources === 0);
  if (used.length > 0) {
    parts.push(
      `Grounded in ${used
        .map((p) => `${p.projectName} (${plural(p.sources, "source", "sources")})`)
        .join(", ")}`,
    );
  } else if (g.projects.length > 0) {
    parts.push("No excerpts matched in any product searched");
  } else {
    parts.push("Not grounded — none of this chat's products could be searched");
  }
  if (used.length > 0 && unused.length > 0) {
    parts.push(`nothing relevant in ${unused.map((p) => p.projectName).join(", ")}`);
  }
  for (const u of g.unsearched ?? []) {
    parts.push(
      `${u.projectName} not searched (${u.reason === "timeout" ? "timed out" : "failed"})`,
    );
  }
  if (g.unavailable) {
    parts.push(`${plural(g.unavailable, "product", "products")} no longer available to you`);
  }
  return parts.join(" · ");
}

/** #2238 — whether every product of a multi-product reply was searched and one contributed. */
function multiGrounded(g: Extract<ChatGrounding, { status: "multi" }>): boolean {
  return g.projects.some((p) => p.sources > 0) && !g.unsearched?.length && !g.unavailable;
}

/** #2241 — the line saying only part of the project could be searched; `null` when all of it could. */
export function coverageText(g: ChatGrounding): string | null {
  if (g.status === "unscoped" || g.status === "multi" || !g.coverage) return null;
  const { matchingChunks, totalChunks } = g.coverage;
  return `Partial coverage — only ${matchingChunks} of ${totalChunks} indexed sections in ${g.projectName} are searchable with the current embedding model; re-index to search the rest`;
}

function relevanceText(relevance: number | undefined): string {
  return relevance === undefined ? "" : ` · relevance ${relevance.toFixed(2)}`;
}

/**
 * Under each assistant reply: what that reply was grounded in. #2241 — and
 * which files and documents its excerpts came from, and a partial coverage.
 */
export function GroundingBadge({ grounding }: { grounding: ChatGrounding | undefined }) {
  if (!grounding) return null;
  const grounded =
    grounding.status === "grounded" || (grounding.status === "multi" && multiGrounded(grounding));
  const sources = grounding.status === "grounded" ? (grounding.sourcesUsed ?? []) : [];
  const coverage = coverageText(grounding);
  return (
    <div
      data-testid="chat-grounding"
      data-grounding={grounding.status}
      {...(grounding.status === "no-context" && grounding.reason
        ? { "data-reason": grounding.reason }
        : {})}
      className={`mt-1 text-xs ${grounded ? "text-muted-foreground" : "text-warning"}`}
    >
      {sources.length > 0 ? (
        <details>
          <summary className="cursor-pointer">{groundingText(grounding)}</summary>
          <ul data-testid="chat-grounding-sources" className="mt-1 list-disc pl-5">
            {sources.map((s) => (
              <li key={s.name}>
                <span className="font-mono">{s.name}</span>
                {` · ${plural(s.excerpts, "excerpt", "excerpts")}${relevanceText(s.relevance)}`}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p>{groundingText(grounding)}</p>
      )}
      {coverage ? (
        <p data-testid="chat-grounding-coverage" className="text-warning">
          {coverage}
        </p>
      ) : null}
    </div>
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
      general knowledge, not your code or documents. Pick one or more projects, or your workspace,
      to ground answers in them.
    </p>
  );
}
