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
        // #2326 — the class of failure, a fixed phrase; never the error's text.
        const why = g.failure ? ` (${g.failure})` : "";
        return `Retrieval failed — ${g.projectName}'s knowledge base could not be searched for this reply${why}; check any file or code it names`;
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
  } else if (g.projects.length > 0 && g.reason === "insufficient-evidence") {
    // #2294 — as for one project: the matches were found, and too weak to use.
    const weak = g.belowFloor
      ? ` (${plural(g.belowFloor, "weak match", "weak matches")} set aside)`
      : "";
    parts.push(
      `Insufficient evidence — nothing in the products searched was relevant enough to this question${weak}; check any file or code it names`,
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

type GroundingIndexOf = NonNullable<Extract<ChatGrounding, { status: "grounded" }>["index"]>;

function indexOf(g: ChatGrounding): GroundingIndexOf | undefined {
  return g.status === "grounded" || g.status === "no-context" ? g.index : undefined;
}

/** `2026-11-12T05:27:41.000Z` → `2026-11-12 05:27 UTC`. */
function indexedAtText(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * #2326 — what the project's index was when the reply was answered: each
 * repository's last indexed commit and time and how its last indexing run
 * ended. `null` when the server sent no index facts (or the project has no
 * repository).
 */
export function indexText(g: ChatGrounding): string | null {
  const index = indexOf(g);
  if (!index || index.repos.length === 0) return null;
  const repos = index.repos.map((r) => {
    const commit = r.commitSha ? ` @ ${r.commitSha.slice(0, 7)}` : "";
    const when = r.indexedAt ? `, indexed ${indexedAtText(r.indexedAt)}` : ", never indexed";
    const run = `last run ${r.lastRun}${r.error ? ` (${r.error})` : ""}`;
    return `${r.label}${commit}${when} · ${run}`;
  });
  return `Index: ${repos.join("; ")}`;
}

const INDEX_WARNINGS: Record<Exclude<GroundingIndexOf["state"], "healthy">, string> = {
  failed: "the last indexing run failed",
  "never-indexed": "nothing in this project has been indexed yet",
  "in-progress": "indexing is still in progress",
  partial: "the index is partial",
};

/**
 * What is wrong with one repository's index, in the server's order
 * (`repoState` in `index-status.ts`); `null` when nothing is.
 */
function repoIssue(r: GroundingIndexOf["repos"][number]): string | null {
  if (r.lastRun === "running") return `${r.label} is still being indexed`;
  if (r.lastRun === "failed" || r.error) {
    return `the last indexing of ${r.label} failed${r.error ? ` (${r.error})` : ""}`;
  }
  if (r.lastRun === "partial") return `the index of ${r.label} is partial`;
  if (r.lastRun === "interrupted") return `indexing of ${r.label} was interrupted`;
  if (r.lastRun === "never") return `repository ${r.label} is not indexed yet`;
  return null;
}

/**
 * #2326 — a warning when the index is failed, empty, partial or being built;
 * `null` when healthy. It names the part that is missing — one repository not
 * indexed yet beside indexed documents is not "nothing indexed" (#2384).
 */
export function indexWarningText(g: ChatGrounding): string | null {
  const index = indexOf(g);
  if (!index || index.state === "healthy") return null;
  const issues = index.repos.map(repoIssue).filter((i): i is string => i !== null);
  const what =
    index.state === "never-indexed" || issues.length === 0
      ? INDEX_WARNINGS[index.state]
      : issues.join("; ");
  return `Index warning — ${what}, so this reply may miss code or documents that are not indexed`;
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
  // #2294 — a multi-product reply lists its sources too, each named with its product.
  const sources =
    grounding.status === "grounded" || grounding.status === "multi"
      ? (grounding.sourcesUsed ?? [])
      : [];
  const reason =
    grounding.status === "no-context" || grounding.status === "multi"
      ? grounding.reason
      : undefined;
  const coverage = coverageText(grounding);
  const index = indexText(grounding);
  const indexWarning = indexWarningText(grounding);
  return (
    <div
      data-testid="chat-grounding"
      data-grounding={grounding.status}
      {...(reason ? { "data-reason": reason } : {})}
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
      {indexWarning ? (
        <p data-testid="chat-grounding-index-warning" className="text-warning">
          {indexWarning}
        </p>
      ) : null}
      {index ? (
        <p data-testid="chat-grounding-index" className="text-muted-foreground">
          {index}
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
