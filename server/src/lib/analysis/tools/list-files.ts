/**
 * Epic #473 / Issue #475 — list_files tool.
 *
 * Globs the clone directory to let the agent discover files. Returns up to
 * 100 results.
 *
 * #2327 — chat offers it too (`chat-file-tools.ts`), so the pattern comes from
 * a model:
 *   - it is validated (`checkRepoGlob`: no absolute path, no `..`, bounded in
 *     length and segments) and matched by `glob-match.ts`, which cannot
 *     backtrack, instead of a compiled regular expression;
 *   - past the 100 shown, the walk keeps counting, so a cut list says how many
 *     files matched (or "at least", when the walk's own cap was reached);
 *   - a caller may exclude files (`isExcluded`): chat passes the caller's
 *     document ACLs, and an excluded file is neither listed nor counted.
 * Hidden entries (`.git`, `.env*`, …), `node_modules` and symlinks are never
 * listed, and a symlinked directory is never descended into.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, ToolContext, ToolResult, JSONSchema } from "./types.js";
import { missingParamError } from "./arg-errors.js";
import { checkRepoGlob, isSensitiveRepoPath, repoPathError } from "./repo-paths.js";
import { compileGlob } from "../../code-graph/glob-match.js";

/** Paths returned per call, at most. */
export const MAX_RESULTS = 100;
/** #2327 — directory entries visited per call, at most; past it the totals are lower bounds. */
export const MAX_ENTRIES_VISITED = 50_000;

const TOOL = "list_files";

export interface ListFilesArgs {
  pattern: string;
}

const parameters: JSONSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        "Glob pattern to match repository-relative file paths (e.g., 'src/**/*.ts', '*.json'). " +
        "`*` matches within a directory, `**` across directories, `?` one character.",
    },
  },
  required: ["pattern"],
};

type ParsedArgs = { ok: true; args: ListFilesArgs } | { ok: false; result: ToolResult };

/** The call's arguments, or the error to return. */
export function parseListFilesArgs(args: unknown): ParsedArgs {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  if (!a || typeof a.pattern !== "string" || a.pattern.trim() === "") {
    // #774 — name the received keys so the model can self-repair in one turn.
    return {
      ok: false,
      result: {
        content: missingParamError({
          tool: TOOL,
          param: "pattern",
          expected: "non-empty glob string",
          args,
          example: "src/**/*.ts",
        }),
        isError: true,
      },
    };
  }
  const checked = checkRepoGlob(a.pattern);
  if (!checked.ok) {
    return {
      ok: false,
      result: { content: repoPathError(TOOL, "pattern", checked.reason), isError: true },
    };
  }
  return { ok: true, args: { pattern: checked.value } };
}

/** What one listing found, summed over every clone it walked. */
export interface ListTally {
  shown: string[];
  /** Matching files, shown or not. */
  total: number;
  /** The walk's entry cap stopped it with entries left: {@link total} is a lower bound. */
  cutShort: boolean;
  /** Entries visited over every clone, skipped hidden and `node_modules` entries not counted. */
  visited: number;
}

export function emptyListTally(): ListTally {
  return { shown: [], total: 0, cutShort: false, visited: 0 };
}

export interface ListCloneOptions {
  /** #2327 — a file the caller may not see (repository-relative). Neither listed nor counted. */
  isExcluded?: (rel: string) => boolean;
  /** Test seam: the walk's entry cap, over every clone the tally is summed over. */
  maxEntriesVisited?: number;
  /** #2327 — put before each listed path; chat names the repository when it listed several. */
  linePrefix?: string;
}

/**
 * List one clone's files matching `args.pattern`, adding to `tally`. Returns
 * `false` when the clone directory is not there.
 */
export async function listCloneFiles(
  cloneDir: string,
  args: ListFilesArgs,
  tally: ListTally,
  opts: ListCloneOptions = {},
): Promise<boolean> {
  try {
    await fs.access(cloneDir);
  } catch {
    return false;
  }
  const matches = compileGlob(args.pattern);
  const maxVisited = opts.maxEntriesVisited ?? MAX_ENTRIES_VISITED;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (tally.cutShort) return;
      // Skip hidden entries and common non-source directories. #2327 — before
      // the cap, so a clone full of them is not cut short by what it skips.
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (tally.visited >= maxVisited) {
        tally.cutShort = true;
        return;
      }
      tally.visited++;
      const full = path.join(dir, entry.name);
      // A symlink is neither a directory nor a file here: never followed, never listed.
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(cloneDir, full).split(path.sep).join("/");
      if (!matches(rel) || isSensitiveRepoPath(rel) || opts.isExcluded?.(rel)) continue;
      tally.total++;
      if (tally.shown.length < MAX_RESULTS) tally.shown.push(`${opts.linePrefix ?? ""}${rel}`);
    }
  }
  await walk(cloneDir);
  return true;
}

/** The tool result for a finished tally. */
export function listFilesResult(args: ListFilesArgs, tally: ListTally): ToolResult {
  if (tally.shown.length === 0) {
    return tally.cutShort
      ? {
          content:
            `No files matching pattern: ${args.pattern} among the first ${tally.visited} ` +
            "entries; more were not listed. Narrow the pattern to a directory.",
          truncated: true,
          resultCount: 0,
        }
      : { content: `No files matching pattern: ${args.pattern}`, resultCount: 0 };
  }
  const truncated = tally.cutShort || tally.shown.length < tally.total;
  if (!truncated) {
    return { content: tally.shown.join("\n"), truncated: false, resultCount: tally.shown.length };
  }
  const atLeast = tally.cutShort ? "at least " : "";
  return {
    content:
      `${tally.shown.join("\n")}\n[truncated: showing ${tally.shown.length} of ${atLeast}` +
      `${tally.total} matching file(s)` +
      (tally.cutShort ? `; the listing stopped after ${tally.visited} entries` : "") +
      "; narrow the pattern to see the rest]",
    truncated: true,
    resultCount: tally.shown.length,
  };
}

async function execute(args: unknown, context: ToolContext): Promise<ToolResult> {
  const parsed = parseListFilesArgs(args);
  if (!parsed.ok) return parsed.result;

  if (!context.cloneDir) {
    return {
      content: "Error: No repository clone directory configured for this project.",
      isError: true,
    };
  }

  // #2314 — the analysis code agent's caller may not see every file (#2243):
  // a hidden one is neither listed nor counted, as in chat's `list_files`.
  const access = context.codeAccess;
  const repo = context.connectorId ?? null;
  const tally = emptyListTally();
  const opts: ListCloneOptions =
    access && !access.unrestricted ? { isExcluded: (rel) => access.isHidden(repo, rel) } : {};
  if (!(await listCloneFiles(context.cloneDir, parsed.args, tally, opts))) {
    return { content: "Error: Repository clone directory not found.", isError: true };
  }
  return listFilesResult(parsed.args, tally);
}

export const LIST_FILES_DESCRIPTION =
  "List files in the repository matching a glob pattern. Returns relative file paths. " +
  `Max ${MAX_RESULTS} results, with the total when there are more. Use to discover project ` +
  "structure before reading specific files.";

export { parameters as LIST_FILES_PARAMETERS };

export const listFilesTool: AgentTool = {
  name: TOOL,
  description: LIST_FILES_DESCRIPTION,
  parameters,
  execute,
};
