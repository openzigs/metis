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
 *     moves on to the next repo — a traversal refusal or bad args returns at once;
 *   • git internals and credential files (`isSensitiveRepoPath`: `.git/`, `.ssh/`,
 *     `.env*`, private keys, …) are refused before any read, on the path as asked AND
 *     where it really resolves, so an in-repo symlink to one is refused too (#2327). A
 *     chat result goes to the model provider and is kept in full in the transcript,
 *     and a committed secret file should not travel that way;
 *   • #2243 — a file whose document the caller may not see (its ACL, or a shared
 *     audience) is refused with the reply a missing file gets.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { readFileSliceTool } from "./read-file-slice.js";
import { NO_WORKING_TREE, resolveChatClones, type ChatCloneDeps } from "./chat-clones.js";
import { UNRESTRICTED_CODE_ACCESS, type CodeAccessFilter } from "./code-access.js";
import { isSensitiveInClone, isSensitiveRepoPath, notAccessible } from "./repo-paths.js";
import type { AgentTool, ToolContext, ToolResult } from "./types.js";

export type ChatReadFileSliceDeps = ChatCloneDeps;

function hasFilePath(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const p = (args as Record<string, unknown>).filePath;
  return typeof p === "string" && p.trim() !== "";
}

const NOT_FOUND = "Error: File not found:";

// #2327 — moved to `repo-paths.ts`, where `grep_files` and `list_files` read it too.
export { isSensitiveRepoPath };

/**
 * #2243 — whether `filePath` in the clone of `repoId` is a hidden file. Checked
 * on the path as asked AND on where it really resolves, so a symlink inside the
 * repository (`public.ts -> secret.ts`) cannot read a hidden file under
 * another name.
 */
async function isHiddenInClone(
  access: CodeAccessFilter,
  repoId: string,
  cloneDir: string,
  filePath: string,
): Promise<boolean> {
  const asked = path.relative(path.resolve(cloneDir), path.resolve(cloneDir, filePath));
  if (access.isHidden(repoId, asked)) return true;
  try {
    const [real, root] = await Promise.all([
      fs.realpath(path.resolve(cloneDir, filePath)),
      fs.realpath(cloneDir),
    ]);
    return access.isHidden(repoId, path.relative(root, real));
  } catch {
    return false; // not on disk: the read below reports it as not found
  }
}

export function createChatReadFileSliceTool(deps: ChatReadFileSliceDeps = {}): AgentTool {
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
      const filePath = (args as { filePath: string }).filePath;
      // #2327 — refused with the reply a missing file gets, before any read.
      if (isSensitiveRepoPath(filePath)) return { content: notAccessible(filePath), isError: true };
      const dirs = await resolveChatClones(ctx.projectId, deps);
      if (dirs.length === 0) return { content: NO_WORKING_TREE, isError: true };
      // #2243 — a file whose document the caller may not see is treated as
      // absent from that repository, and once anything is hidden from the
      // caller a missing file and a hidden one get the SAME reply: the reply
      // must not confirm that a restricted file exists. #2327 — so is a path
      // that resolves (through a symlink) to git internals or a credential file.
      const access = ctx.codeAccess ?? UNRESTRICTED_CODE_ACCESS;
      let last: ToolResult | undefined;
      let refused = false;
      for (const { id, dir: cloneDir } of dirs) {
        if (
          (await isSensitiveInClone(cloneDir, filePath)) ||
          (!access.unrestricted && (await isHiddenInClone(access, id, cloneDir, filePath)))
        ) {
          refused = true;
          last = undefined;
          continue;
        }
        last = await readFileSliceTool.execute(args, { projectId: ctx.projectId, cloneDir });
        if (!(last.isError && last.content.startsWith(NOT_FOUND))) return last;
      }
      if (access.unrestricted && !refused && last) return last;
      return { content: notAccessible(filePath), isError: true };
    },
  };
}
