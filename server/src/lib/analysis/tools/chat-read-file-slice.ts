/**
 * #736 — `read_file_slice` for CHAT.
 *
 * Chat could find a symbol's `file:line` (search_code_graph / search_code_symbols)
 * but had no way to read the lines it cited, so every answer was self-declared
 * unverified. The analysis surface's {@link readFileSliceTool} already does the
 * bounded read (200 lines per call, path containment, symlink-escape check); this
 * wraps it for a chat session, which knows only its PROJECT, not a clone dir:
 *
 *   • the clone dirs come from the session project's own live repo connections
 *     (filtered on `projectId` — never on a connector id alone), primary first;
 *   • a clone that is not on disk is skipped (`resolveExistingCloneDir`, #777);
 *   • the file is read from the first clone that has it. Only "file not found"
 *     moves on to the next repo — a traversal refusal or bad args returns at once.
 */
import { prisma } from "../../prisma.js";
import { resolveExistingCloneDir } from "../clone-availability.js";
import { readFileSliceTool } from "./read-file-slice.js";
import type { AgentTool, ToolContext, ToolResult } from "./types.js";

export interface ChatReadFileSliceDeps {
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

function hasFilePath(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const p = (args as Record<string, unknown>).filePath;
  return typeof p === "string" && p.trim() !== "";
}

const NOT_FOUND = "Error: File not found:";

export function createChatReadFileSliceTool(deps: ChatReadFileSliceDeps = {}): AgentTool {
  const listRepoIds = deps.listRepoIds ?? projectRepoIds;
  const resolveCloneDir = deps.resolveCloneDir ?? resolveExistingCloneDir;
  return {
    name: readFileSliceTool.name,
    description:
      "Read a range of lines from a file in this project's repository, to quote the code behind a " +
      "file:line you found with search_code_graph or search_code_symbols. Returns numbered lines. " +
      "Max 200 lines per call.",
    parameters: readFileSliceTool.parameters,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      // Bad args: the shared tool authors the repairable message (#774).
      if (!hasFilePath(args)) return readFileSliceTool.execute(args, { projectId: ctx.projectId });
      if (!ctx.projectId) {
        return { content: "Error: reading a file needs a project-scoped session.", isError: true };
      }
      const dirs: string[] = [];
      for (const id of await listRepoIds(ctx.projectId)) {
        const dir = await resolveCloneDir(id);
        if (dir) dirs.push(dir);
      }
      if (dirs.length === 0) {
        return {
          content:
            "Error: No repository working tree is available for this project, so file contents " +
            "cannot be read. Cite the file:line locators from the code search tools instead.",
          isError: true,
        };
      }
      let last: ToolResult | undefined;
      for (const cloneDir of dirs) {
        last = await readFileSliceTool.execute(args, { projectId: ctx.projectId, cloneDir });
        if (!(last.isError && last.content.startsWith(NOT_FOUND))) return last;
      }
      return last as ToolResult;
    },
  };
}
