/**
 * #736 / #2327 — the repository clones a CHAT code tool may read: the session
 * project's own live repo connections (filtered on `projectId`, never on a
 * connector id alone), primary first, each only when its clone is on disk
 * (`resolveExistingCloneDir`, #777). Shared by `read_file_slice`, `grep_files`
 * and `list_files` on the chat surface.
 */
import { prisma } from "../../prisma.js";
import { resolveExistingCloneDir } from "../clone-availability.js";

export interface ChatCloneDeps {
  /**
   * The project's live repo connections, in search order: an id, or an id
   * with the label a multi-repository result names it by (the id when absent).
   */
  listRepoIds?: (projectId: string) => Promise<Array<string | { id: string; label: string }>>;
  /** A connector's clone dir, only when it exists and is readable. */
  resolveCloneDir?: (connectorId: string) => Promise<string | undefined>;
}

async function projectRepoIds(projectId: string): Promise<Array<{ id: string; label: string }>> {
  return prisma.repoConnection.findMany({
    where: { projectId, deletedAt: null },
    select: { id: true, label: true },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
}

/** A clone on disk: its repo connection id, its label, and its directory. */
export interface ChatClone {
  id: string;
  label: string;
  dir: string;
}

/** The clones on disk, in search order. */
export async function resolveChatClones(
  projectId: string,
  deps: ChatCloneDeps = {},
): Promise<ChatClone[]> {
  const listRepoIds = deps.listRepoIds ?? projectRepoIds;
  const resolveCloneDir = deps.resolveCloneDir ?? resolveExistingCloneDir;
  const dirs: ChatClone[] = [];
  for (const repo of await listRepoIds(projectId)) {
    const { id, label } = typeof repo === "string" ? { id: repo, label: repo } : repo;
    const dir = await resolveCloneDir(id);
    if (dir) dirs.push({ id, label, dir });
  }
  return dirs;
}

/** The reply when a project has no clone on disk. */
export const NO_WORKING_TREE =
  "Error: No repository working tree is available for this project, so file contents " +
  "cannot be read. Cite the file:line locators from the code search tools instead.";
