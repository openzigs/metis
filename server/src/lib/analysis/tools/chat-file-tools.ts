/**
 * #2327 — `grep_files` and `list_files` for CHAT.
 *
 * The analysis surface runs both on one clone it was handed. A chat session
 * knows only its PROJECT, so these wrap the same implementations
 * (`grep-files.ts`, `list-files.ts`) the way `read_file_slice` is wrapped
 * (`chat-read-file-slice.ts`):
 *   - the clones are the session project's own live repo connections, primary
 *     first, each only when it is on disk (`chat-clones.ts`);
 *   - every clone is searched, and the caps (`maxFilesScanned`, the entry
 *     caps) and the totals are over all of them, not per clone;
 *   - when there is more than one clone, each line names its repository by
 *     label (`[label] path…`), so two files of one path stay apart;
 *   - git internals and credential files (`isSensitiveRepoPath`) are neither
 *     read nor listed, on the path as listed or where a symlink resolves;
 *   - #2243 — a file whose document the caller may not see (its ACL, or a
 *     shared audience) is excluded: neither shown nor counted, so a result
 *     never confirms that a restricted file exists. For `grep_files` the check
 *     is on the path as listed AND the path a symlink resolves to.
 * Both are in-process walks: no argument reaches a shell.
 */
import { UNRESTRICTED_CODE_ACCESS } from "./code-access.js";
import { NO_WORKING_TREE, resolveChatClones, type ChatCloneDeps } from "./chat-clones.js";
import {
  emptyGrepTally,
  grepClone,
  grepResult,
  GREP_FILES_DESCRIPTION,
  GREP_FILES_PARAMETERS,
  MAX_FILES_SCANNED,
  parseGrepArgs,
} from "./grep-files.js";
import {
  emptyListTally,
  listCloneFiles,
  listFilesResult,
  LIST_FILES_DESCRIPTION,
  LIST_FILES_PARAMETERS,
  parseListFilesArgs,
} from "./list-files.js";
import type { AgentTool, ToolContext, ToolResult } from "./types.js";

const NEEDS_PROJECT: ToolResult = {
  content: "Error: searching files needs a project-scoped session.",
  isError: true,
};

/** How a multi-repository result names a line's repository. */
const repoPrefix = (label: string): string => `[${label.replace(/[\r\n\]]/g, " ")}] `;

export function createChatGrepFilesTool(deps: ChatCloneDeps = {}): AgentTool {
  return {
    name: "grep_files",
    description: GREP_FILES_DESCRIPTION,
    parameters: GREP_FILES_PARAMETERS,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseGrepArgs(args);
      if (!parsed.ok) return parsed.result;
      if (!ctx.projectId) return NEEDS_PROJECT;
      const clones = await resolveChatClones(ctx.projectId, deps);
      if (clones.length === 0) return { content: NO_WORKING_TREE, isError: true };
      const access = ctx.codeAccess ?? UNRESTRICTED_CODE_ACCESS;
      const tally = emptyGrepTally();
      for (const { id, label, dir } of clones) {
        await grepClone(dir, parsed.args, tally, {
          maxFilesScanned: MAX_FILES_SCANNED,
          ...(clones.length > 1 ? { linePrefix: repoPrefix(label) } : {}),
          ...(access.unrestricted
            ? {}
            : {
                isExcluded: (rel: string, realRel: string) =>
                  access.isHidden(id, rel) || access.isHidden(id, realRel),
              }),
        });
      }
      return grepResult(parsed.args, tally, MAX_FILES_SCANNED);
    },
  };
}

export function createChatListFilesTool(deps: ChatCloneDeps = {}): AgentTool {
  return {
    name: "list_files",
    description: LIST_FILES_DESCRIPTION,
    parameters: LIST_FILES_PARAMETERS,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseListFilesArgs(args);
      if (!parsed.ok) return parsed.result;
      if (!ctx.projectId) return NEEDS_PROJECT;
      const clones = await resolveChatClones(ctx.projectId, deps);
      if (clones.length === 0) return { content: NO_WORKING_TREE, isError: true };
      const access = ctx.codeAccess ?? UNRESTRICTED_CODE_ACCESS;
      const tally = emptyListTally();
      for (const { id, label, dir } of clones) {
        await listCloneFiles(dir, parsed.args, tally, {
          ...(clones.length > 1 ? { linePrefix: repoPrefix(label) } : {}),
          ...(access.unrestricted ? {} : { isExcluded: (rel: string) => access.isHidden(id, rel) }),
        });
      }
      return listFilesResult(parsed.args, tally);
    },
  };
}
