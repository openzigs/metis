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
 * The grounding of one turn: `contexts` are the retrieved excerpts exactly as
 * they were handed to the model (`RagContextCapture.contexts`), so a reply is
 * `grounded` only when something actually reached the prompt.
 */
export async function describeGrounding(
  projectId: string | null,
  contexts: readonly string[],
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
  return contexts.length > 0
    ? { status: "grounded", projectId, projectName: name, sources: contexts.length }
    : { status: "no-context", projectId, projectName: name };
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
