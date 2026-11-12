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
  /** The project's live repo connection ids, in search order. */
  listRepoIds?: (projectId: string) => Promise<string[]>;
  /** A connector's clone dir, only when it exists and is readable. */
  resolveCloneDir?: (connectorId: string) => Promise<string | undefined>;
}

async function projectRepoIds(projectId: string): Promise<string[]> {
  const rows = await prisma.repoConnection.findMany({
    where: { projectId, deletedAt: null },
    select: { id: true },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => r.id);
}

/** The clones on disk, as `{ id: repoConnectionId, dir }`, in search order. */
export async function resolveChatClones(
  projectId: string,
  deps: ChatCloneDeps = {},
): Promise<Array<{ id: string; dir: string }>> {
  const listRepoIds = deps.listRepoIds ?? projectRepoIds;
  const resolveCloneDir = deps.resolveCloneDir ?? resolveExistingCloneDir;
  const dirs: Array<{ id: string; dir: string }> = [];
  for (const id of await listRepoIds(projectId)) {
    const dir = await resolveCloneDir(id);
    if (dir) dirs.push({ id, dir });
  }
  return dirs;
}

/** The reply when a project has no clone on disk. */
export const NO_WORKING_TREE =
  "Error: No repository working tree is available for this project, so file contents " +
  "cannot be read. Cite the file:line locators from the code search tools instead.";
