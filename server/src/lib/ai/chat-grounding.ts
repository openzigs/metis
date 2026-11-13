/**
 * #18 — say what a chat reply was grounded in.
 *
 * Retrieval (`buildAutoRagContext`) runs only for a session bound to one
 * project. An "All projects" chat has no project, so the model answers from its
 * own knowledge — and before #18 nothing on screen said so. This module turns
 * the retrieval outcome of a turn into a {@link ChatGrounding} that is streamed
 * to the client and recorded on the assistant row.
 */
import {
  MAX_GROUNDING_SOURCES,
  parseChatGrounding,
  type ChatGrounding,
  type GroundingCoverage,
  type GroundingIndex,
  type GroundingSource,
  type IndexErrorClass,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import type { ToolSource } from "./tool-runtime/types.js";

export type { ChatGrounding };

/** Looks up a project's display name; `null` when the project is gone. */
export type ProjectNameLookup = (projectId: string) => Promise<string | null>;

const lookupProjectName: ProjectNameLookup = async (projectId) => {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  return project?.name?.trim() || null;
};

/**
 * #2241 — what one turn's automatic retrieval did, as `RagContextCapture`
 * records it: how many excerpts reached the prompt, which ones, how many the
 * relevance floor set aside, whether the search failed, and whether only part
 * of the project could be searched.
 */
export interface RetrievalOutcome {
  sources: number;
  excerpts?: readonly { name: string; relevance?: number }[];
  belowFloor?: number;
  failed?: boolean;
  coverage?: GroundingCoverage;
  /** #2326 — the class of a failed search. */
  failure?: IndexErrorClass;
  /** #2326 — the project's index when the turn retrieved. */
  index?: GroundingIndex;
}

/**
 * #2241 — the files and documents a turn's excerpts came from, in the order
 * the model was shown them: one entry per name, with how many excerpts it gave
 * and the best relevance among them.
 */
export function groundingSources(
  excerpts: readonly { name: string; relevance?: number }[],
): GroundingSource[] {
  const byName = new Map<string, GroundingSource>();
  for (const e of excerpts) {
    const entry = byName.get(e.name) ?? { name: e.name, excerpts: 0 };
    entry.excerpts++;
    if (e.relevance !== undefined) {
      const r = Number(e.relevance.toFixed(3));
      if (entry.relevance === undefined || r > entry.relevance) entry.relevance = r;
    }
    byName.set(e.name, entry);
  }
  return [...byName.values()].slice(0, MAX_GROUNDING_SOURCES);
}

/**
 * The grounding of one turn's automatic retrieval. `sources` is how many
 * excerpts reached the prompt (`RagContextCapture.sources`: one per
 * knowledge-base chunk plus one per fused code symbol), so a reply is
 * `grounded` only when something actually reached the prompt. What the tools
 * read later in the turn is folded in by {@link withToolReads}.
 *
 * #2241 — given the whole {@link RetrievalOutcome}, the label also lists the
 * sources, says why nothing was supplied, and says when coverage was partial.
 */
export async function describeGrounding(
  projectId: string | null,
  retrieval: number | RetrievalOutcome,
  lookup: ProjectNameLookup = lookupProjectName,
): Promise<ChatGrounding> {
  if (!projectId) return { status: "unscoped" };
  const r: RetrievalOutcome = typeof retrieval === "number" ? { sources: retrieval } : retrieval;
  let projectName: string | null = null;
  try {
    projectName = await lookup(projectId);
  } catch {
    /* the name is a label; the grounding status does not depend on it */
  }
  const name = projectName ?? "this project";
  const coverage = r.coverage ? { coverage: r.coverage } : {};
  const index = r.index ? { index: r.index } : {};
  if (r.sources > 0) {
    const sourcesUsed = groundingSources(r.excerpts ?? []);
    return {
      status: "grounded",
      projectId,
      projectName: name,
      sources: r.sources,
      ...(sourcesUsed.length > 0 ? { sourcesUsed } : {}),
      ...coverage,
      ...index,
    };
  }
  if (typeof retrieval === "number") return { status: "no-context", projectId, projectName: name };
  const belowFloor = r.belowFloor ?? 0;
  return {
    status: "no-context",
    projectId,
    projectName: name,
    reason: r.failed
      ? "retrieval-failed"
      : belowFloor > 0
        ? "insufficient-evidence"
        : "nothing-found",
    ...(!r.failed && belowFloor > 0 ? { belowFloor } : {}),
    ...coverage,
    ...(r.failed && r.failure ? { failure: r.failure } : {}),
    ...index,
  };
}

/** What {@link countProjectToolReads} needs to know about one tool call. */
export interface GroundingToolCall {
  /** Canonical tool name (the executor records the canonical, not the wire, name). */
  tool?: string;
  source?: ToolSource;
  executed: boolean;
  isError?: boolean;
  resultCount?: number;
}

/**
 * #464 — METIS registry tools that read only the session's project. The
 * project-scoped `search-knowledge` searches only the session's project in a
 * bound session (#736: it ignores a `projectId` argument naming any other), so a
 * successful call with hits read this project's knowledge base. Its cross-project sibling `search-knowledge-global` is deliberately
 * absent (and is not offered to a scoped chat — `CHAT_EXCLUDED_TOOLS`).
 */
const PROJECT_READ_METIS_TOOLS: ReadonlySet<string> = new Set([
  "search-knowledge",
  // #1030 — read the session project's requirements (refused when unscoped).
  "list_requirements",
  "get_requirement",
  // #2239 — the session project's analyses, findings, clarification answers and
  // governing findings (refused when unscoped; every query filters on the
  // project). The impact-analysis and portfolio-check tools are left out: a run
  // that includes this project also reports on other projects and products.
  "list_analyses",
  "get_analysis",
  "list_clarification_answers",
  "get_governing_findings",
]);

function readsProject(c: GroundingToolCall): boolean {
  if (c.source === "code") return true;
  return c.source === "metis" && c.tool !== undefined && PROJECT_READ_METIS_TOOLS.has(c.tool);
}

/**
 * #439 — how many of a turn's tool calls read the project: a curated code tool
 * (`source: "code"` — read-only, and scoped to the session's project by the
 * server, never by the model) or a project-scoped METIS read tool (#464,
 * `search-knowledge`) that ran, did not fail, and returned at least one result.
 * MCP, sub-agent and other METIS tools are not counted: what they return is not
 * known to be the project's content. In an unscoped session the count is
 * ignored ({@link withToolReads}), since no call there is bound to a project.
 */
export function countProjectToolReads(calls: readonly GroundingToolCall[]): number {
  return calls.filter(
    (c) =>
      readsProject(c) &&
      c.executed &&
      !c.isError &&
      typeof c.resultCount === "number" &&
      c.resultCount > 0,
  ).length;
}

/**
 * #439 — fold a turn's project tool reads into its grounding. A `no-context`
 * turn whose tools read the project becomes `grounded` (with `sources: 0`); an
 * unscoped turn stays unscoped.
 *
 * #464 / PR #471 review — that unscoped guard is load-bearing, not cosmetic:
 * `search-knowledge` is pinned to the session's project only when the session
 * HAS one (search-knowledge-tool.ts), so in an unscoped chat it can search any
 * project. Counting those reads would label an answer grounded in a project the
 * chat is not scoped to. Pinned by "keeps an unscoped turn unscoped".
 */
export function withToolReads(grounding: ChatGrounding, toolReads: number): ChatGrounding {
  // #2238 — a multi-product session is offered no project-bound tool (it has
  // no `projectId`), so no call there read one of its projects.
  if (toolReads <= 0 || grounding.status === "unscoped" || grounding.status === "multi") {
    return grounding;
  }
  const sources = grounding.status === "grounded" ? grounding.sources : 0;
  return {
    status: "grounded",
    projectId: grounding.projectId,
    projectName: grounding.projectName,
    sources,
    toolReads,
    // #2241 — what auto-retrieval listed, and a partial coverage, still stand.
    ...(grounding.status === "grounded" && grounding.sourcesUsed
      ? { sourcesUsed: grounding.sourcesUsed }
      : {}),
    ...(grounding.coverage ? { coverage: grounding.coverage } : {}),
    // #2326 — the index facts stand whatever the tools read.
    ...(grounding.index ? { index: grounding.index } : {}),
  };
}

/**
 * Read a {@link ChatGrounding} back from a stored row's `meta`. The row's meta
 * is free-form JSON, so anything that is not a well-formed grounding reads as
 * `null` (not known) rather than being passed through to the client.
 */
export function readGrounding(
  meta: Record<string, unknown> | null | undefined,
): ChatGrounding | null {
  return parseChatGrounding(meta?.grounding);
}
