/**
 * #18 — say what a chat reply was grounded in.
 *
 * Retrieval (`buildAutoRagContext`) runs only for a session bound to one
 * project. An "All projects" chat has no project, so the model answers from its
 * own knowledge — and before #18 nothing on screen said so. This module turns
 * the retrieval outcome of a turn into a {@link ChatGrounding} that is streamed
 * to the client and recorded on the assistant row.
 */
import { parseChatGrounding, type ChatGrounding } from "@metis/shared";
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
 * The grounding of one turn's automatic retrieval. `sources` is how many
 * excerpts reached the prompt (`RagContextCapture.sources`: one per
 * knowledge-base chunk plus one per fused code symbol), so a reply is
 * `grounded` only when something actually reached the prompt. What the tools
 * read later in the turn is folded in by {@link withToolReads}.
 */
export async function describeGrounding(
  projectId: string | null,
  sources: number,
  lookup: ProjectNameLookup = lookupProjectName,
): Promise<ChatGrounding> {
  if (!projectId) return { status: "unscoped" };
  let projectName: string | null = null;
  try {
    projectName = await lookup(projectId);
  } catch {
    /* the name is a label; the grounding status does not depend on it */
  }
  const name = projectName ?? "this project";
  return sources > 0
    ? { status: "grounded", projectId, projectName: name, sources }
    : { status: "no-context", projectId, projectName: name };
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
 * project-scoped `search-knowledge` refuses (`isError`) any project other than
 * the session's, so a successful call with hits read this project's knowledge
 * base. Its cross-project sibling `search-knowledge-global` is deliberately
 * absent (and is not offered to a scoped chat — `CHAT_EXCLUDED_TOOLS`).
 */
const PROJECT_READ_METIS_TOOLS: ReadonlySet<string> = new Set(["search-knowledge"]);

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
 * unscoped turn stays unscoped (its tools cannot reach a project).
 */
export function withToolReads(grounding: ChatGrounding, toolReads: number): ChatGrounding {
  if (toolReads <= 0 || grounding.status === "unscoped") return grounding;
  const sources = grounding.status === "grounded" ? grounding.sources : 0;
  return {
    status: "grounded",
    projectId: grounding.projectId,
    projectName: grounding.projectName,
    sources,
    toolReads,
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
