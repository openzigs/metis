/**
 * `grep_files` — a literal text search over a repository clone.
 *
 * #1755 built it for the eval's arm A3N (the analysis agent with file tools
 * only). #2327 promoted it here so chat can offer it (`chat-file-tools.ts`,
 * behind `CHAT_CODE_SEARCH_PRIMITIVES`); the eval imports this module, so there
 * is one implementation.
 *
 * Bounded on every axis:
 *   - the needle is a LITERAL, case-insensitive substring, never a regular
 *     expression, so no pattern can backtrack; it is 2 to
 *     {@link MAX_NEEDLE_CHARS} characters;
 *   - at most {@link MAX_MATCHES} matching lines, each cut to
 *     {@link MAX_LINE_CHARS} characters, and at most {@link MAX_OUTPUT_CHARS}
 *     characters in all, are returned;
 *   - at most {@link MAX_FILES_SCANNED} files in scope, {@link MAX_FILE_BYTES}
 *     per file and {@link MAX_BYTES_SCANNED} in all are read, and at most
 *     {@link MAX_ENTRIES_VISITED} directory entries visited, over every clone
 *     one search covers;
 *   - the walk never leaves the clone: hidden entries (`.git`, `.env*`, …) and
 *     `node_modules` are skipped, a symlinked directory is never descended into
 *     (#1810), a symlinked file is read only when it resolves inside the clone
 *     and outside every directory the walk skips, and a file whose path — as listed or as resolved — names git internals or
 *     a credential file is never read (#2327).
 *
 * #2327 — past the shown lines the walk keeps COUNTING, so a cut result says
 * how many matching lines and files there were (or "at least", when a file or
 * byte cap stopped the count). A caller may exclude files (`isExcluded`): chat
 * passes the caller's document ACLs, and an excluded file is neither read nor
 * counted.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, JSONSchema, ToolContext, ToolResult } from "./types.js";
import { missingParamError } from "./arg-errors.js";
import { checkRepoPathFragment, isSensitiveRepoPath, repoPathError } from "./repo-paths.js";

/** Matching lines returned per call, at most. */
export const MAX_MATCHES = 50;
/** Files read per call, at most. They count files IN SCOPE: with `pathContains` the walk is not bounded by it (#1819). */
export const MAX_FILES_SCANNED = 5000;
/** #2327 — directory entries the walk visits per call, at most (skipped hidden and `node_modules` entries are not counted). */
export const MAX_ENTRIES_VISITED = 50_000;
/** A larger file is skipped: generated or vendored, not something to grep. */
export const MAX_FILE_BYTES = 512 * 1024;
/** #2327 — bytes read per call, at most, counting continued past the shown lines. */
export const MAX_BYTES_SCANNED = 64 * 1024 * 1024;
/** #2327 — characters of matching lines returned per call, at most. */
export const MAX_OUTPUT_CHARS = 5000;
/** A matching line is cut to this many characters. */
export const MAX_LINE_CHARS = 200;
/** The shortest needle accepted: a one-character needle matches everything. */
const MIN_NEEDLE_CHARS = 2;
/** #2327 — the longest needle accepted. */
export const MAX_NEEDLE_CHARS = 200;

const TOOL = "grep_files";

const parameters: JSONSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description:
        "Literal text to find (case-insensitive substring, not a regex), e.g. a function name or a phrase.",
    },
    pathContains: {
      type: "string",
      description:
        "Optional: only search files whose relative path contains this text, e.g. `/handlers/` or `.go`.",
    },
  },
  required: ["text"],
};

export interface GrepArgs {
  text: string;
  pathContains?: string;
}

type ParsedArgs = { ok: true; args: GrepArgs } | { ok: false; result: ToolResult };

/** The call's arguments, or the error to return. */
export function parseGrepArgs(args: unknown): ParsedArgs {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  if (!a || typeof a.text !== "string" || a.text.trim().length < MIN_NEEDLE_CHARS) {
    return {
      ok: false,
      result: {
        content: missingParamError({
          tool: TOOL,
          param: "text",
          expected: `literal text of at least ${MIN_NEEDLE_CHARS} characters`,
          args,
          example: "refreshFeed",
        }),
        isError: true,
      },
    };
  }
  const text = a.text.trim();
  if (text.length > MAX_NEEDLE_CHARS) {
    return {
      ok: false,
      result: {
        content: repoPathError(TOOL, "text", `it is longer than ${MAX_NEEDLE_CHARS} characters`),
        isError: true,
      },
    };
  }
  if (typeof a.pathContains !== "string" || a.pathContains.trim() === "") {
    return { ok: true, args: { text } };
  }
  const scope = checkRepoPathFragment(a.pathContains);
  if (!scope.ok) {
    return {
      ok: false,
      result: { content: repoPathError(TOOL, "pathContains", scope.reason), isError: true },
    };
  }
  return { ok: true, args: { text, pathContains: scope.value } };
}

/** What one search found, summed over every clone it read. */
export interface GrepTally {
  /** The lines shown, `path:line: text`. */
  shown: string[];
  /** Characters of {@link shown}, newlines included. */
  shownChars: number;
  /** Matching lines found, shown or not. */
  totalMatches: number;
  /** Files with at least one matching line. */
  matchingFiles: number;
  /** Files read. */
  filesSearched: number;
  /** Files in scope listed for reading, over every clone: what the file cap bounds. */
  filesListed: number;
  /** Directory entries visited, over every clone: what the entry cap bounds. */
  entriesVisited: number;
  /** Bytes read. */
  bytesSearched: number;
  /** A file or byte cap stopped the walk with files left unread: the totals are lower bounds. */
  cutShort: boolean;
}

export function emptyGrepTally(): GrepTally {
  return {
    shown: [],
    shownChars: 0,
    totalMatches: 0,
    matchingFiles: 0,
    filesSearched: 0,
    filesListed: 0,
    entriesVisited: 0,
    bytesSearched: 0,
    cutShort: false,
  };
}

export interface GrepCloneOptions {
  /** Files in scope read per call, over every clone the tally is summed over. */
  maxFilesScanned?: number;
  /** Test seam: directory entries visited per call, over every clone. */
  maxEntriesVisited?: number;
  /** #2327 — put before each shown line; chat names the repository when it searched several. */
  linePrefix?: string;
  /**
   * #2327 — a file the caller may not see, by its path as listed and the path
   * it resolves to (they differ for a symlink). Neither read nor counted.
   */
  isExcluded?: (rel: string, realRel: string) => boolean;
}

/** One file the walk found: its path as listed, and the path it resolves to. */
interface ListedFile {
  rel: string;
  realRel: string;
}

const toPosix = (p: string): string => p.split(path.sep).join("/");

/** A walk skips hidden entries and `node_modules`. */
const isSkippedName = (name: string): boolean => name.startsWith(".") || name === "node_modules";

/**
 * Every regular file under `root` whose relative path contains `scope` (all
 * when absent; a scope starting `/` matches at a directory boundary), relative,
 * in a stable order; never outside `root`. The file cap counts files IN SCOPE,
 * so a scoped search on a large clone still reaches the files it asked for
 * (#1810). So with `pathContains` set the file cap does NOT bound the walk:
 * every directory is still listed, and only the files that match the scope are
 * counted against it (#1819). #2327 — the entry cap does bound it, counting only
 * entries the walk does not skip. Both caps are read off `tally`, so they hold
 * over every clone a search covers.
 *
 * A symlinked DIRECTORY is never descended into (#1810): a link such as
 * `x -> ..` or `x -> .` would otherwise walk the same tree forever, and the cap
 * cannot stop a walk that keeps finding directories but no new files. A link
 * is followed only inside the clone, and the walk reaches a directory the link
 * points at by its real path, unless that directory is one the walk skips
 * (hidden, or `node_modules`): a link into one of those is no longer searched
 * at all (#1819). A symlinked FILE inside the clone is still read, unless it
 * resolves into a directory the walk skips, or to a sensitive or excluded file
 * (#2327).
 */
async function listFiles(
  root: string,
  realRoot: string,
  scope: string | undefined,
  tally: GrepTally,
  opts: GrepCloneOptions,
): Promise<ListedFile[]> {
  const maxFiles = opts.maxFilesScanned ?? MAX_FILES_SCANNED;
  const maxEntries = opts.maxEntriesVisited ?? MAX_ENTRIES_VISITED;
  const files: ListedFile[] = [];
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
      if (isSkippedName(entry.name)) continue;
      if (tally.entriesVisited >= maxEntries) {
        tally.cutShort = true;
        return;
      }
      tally.entriesVisited++;
      const full = path.join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = toPosix(path.relative(root, full));
      let realRel = rel;
      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = await fs.realpath(full);
        } catch {
          continue;
        }
        if (!real.startsWith(realRoot + path.sep)) continue;
        const stat = await fs.stat(full).catch(() => null);
        isFile = stat?.isFile() ?? false;
        realRel = toPosix(path.relative(realRoot, real));
        // A link into a directory the walk skips reads nothing there (#2327).
        if (realRel.split("/").slice(0, -1).some(isSkippedName)) continue;
      }
      if (!isFile) continue;
      if (scope && !`/${rel}`.toLowerCase().includes(scope)) continue;
      if (isSensitiveRepoPath(rel) || isSensitiveRepoPath(realRel)) continue;
      if (opts.isExcluded?.(rel, realRel)) continue;
      if (tally.filesListed >= maxFiles) {
        tally.cutShort = true;
        return;
      }
      tally.filesListed++;
      files.push({ rel, realRel });
    }
  }
  await walk(root);
  return files;
}

/**
 * Search one clone for `args`, adding to `tally`. Returns `false` when the
 * clone directory is not there.
 */
export async function grepClone(
  cloneDir: string,
  args: GrepArgs,
  tally: GrepTally,
  opts: GrepCloneOptions = {},
): Promise<boolean> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(cloneDir);
  } catch {
    return false;
  }
  const needle = args.text.toLowerCase();
  const scope = args.pathContains?.toLowerCase();
  const prefix = opts.linePrefix ?? "";
  const files = await listFiles(cloneDir, realRoot, scope, tally, opts);
  for (const { rel } of files) {
    if (tally.bytesSearched >= MAX_BYTES_SCANNED) {
      tally.cutShort = true;
      break;
    }
    const full = path.join(cloneDir, rel);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || stat.size > MAX_FILE_BYTES) continue;
    const body = await fs.readFile(full, "utf8").catch(() => null);
    if (body === null || body.includes("\u0000")) continue; // unreadable or binary
    tally.filesSearched++;
    tally.bytesSearched += stat.size;
    if (!body.toLowerCase().includes(needle)) continue;
    tally.matchingFiles++;
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.toLowerCase().includes(needle)) continue;
      tally.totalMatches++;
      if (tally.shown.length >= MAX_MATCHES) continue;
      const line = `${prefix}${rel}:${i + 1}: ${lines[i]!.trim().slice(0, MAX_LINE_CHARS)}`;
      const cost = line.length + (tally.shown.length > 0 ? 1 : 0);
      if (tally.shownChars + cost > MAX_OUTPUT_CHARS) continue;
      tally.shown.push(line);
      tally.shownChars += cost;
    }
  }
  return true;
}

/**
 * The tool result for a finished tally. `searchedFiles` names the file cap in
 * the "cut short" wording.
 */
export function grepResult(args: GrepArgs, tally: GrepTally, maxFilesScanned: number): ToolResult {
  const truncated = tally.cutShort || tally.shown.length < tally.totalMatches;
  if (tally.shown.length === 0) {
    // #1810 — a search the file cap cut short must not read as "absent".
    return tally.cutShort
      ? {
          content:
            `No lines contain: ${args.text} in the first ${maxFilesScanned} file(s) searched; ` +
            "more files were not searched. Narrow the search with pathContains.",
          truncated: true,
          resultCount: 0,
        }
      : { content: `No lines contain: ${args.text}`, resultCount: 0 };
  }
  if (!truncated) {
    return { content: tally.shown.join("\n"), truncated: false, resultCount: tally.shown.length };
  }
  const atLeast = tally.cutShort ? "at least " : "";
  const footer =
    `[truncated: showing ${tally.shown.length} of ${atLeast}${tally.totalMatches} matching line(s) ` +
    `in ${atLeast}${tally.matchingFiles} file(s); ${tally.filesSearched} file(s) searched` +
    (tally.cutShort ? ", more were not searched — narrow the search with pathContains" : "") +
    "]";
  return {
    content: `${tally.shown.join("\n")}\n${footer}`,
    truncated: true,
    resultCount: tally.shown.length,
  };
}

async function execute(
  args: unknown,
  context: ToolContext,
  maxFilesScanned: number,
): Promise<ToolResult> {
  const parsed = parseGrepArgs(args);
  if (!parsed.ok) return parsed.result;
  if (!context.cloneDir) {
    return {
      content: "Error: No repository clone directory configured for this project.",
      isError: true,
    };
  }
  const tally = emptyGrepTally();
  if (!(await grepClone(context.cloneDir, parsed.args, tally, { maxFilesScanned }))) {
    return { content: "Error: Repository clone directory not found.", isError: true };
  }
  return grepResult(parsed.args, tally, maxFilesScanned);
}

export const GREP_FILES_DESCRIPTION =
  `Search the repository's files for a literal text (case-insensitive, not a regex). Returns up to ` +
  `${MAX_MATCHES} matching lines as \`path:line: text\`, and the totals when there are more. Use it ` +
  "to find where an exact name, message or phrase appears, then read_file_slice to read around a match.";

export { parameters as GREP_FILES_PARAMETERS };

/** The tool with its file cap; tests lower the cap instead of writing thousands of files. */
export function createGrepFilesTool(opts: { maxFilesScanned?: number } = {}): AgentTool {
  const maxFilesScanned = opts.maxFilesScanned ?? MAX_FILES_SCANNED;
  return {
    name: TOOL,
    description: GREP_FILES_DESCRIPTION,
    parameters,
    execute: (args, context) => execute(args, context, maxFilesScanned),
  };
}

export const grepFilesTool: AgentTool = createGrepFilesTool();
