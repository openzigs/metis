/**
 * #1755 — `grep_files`, an EVAL-ONLY text search over a repository clone, for
 * arm A3N: the analysis agent with file tools only (`list_files`,
 * `read_file_slice`, this), no code-graph or symbol search. It answers "what
 * does the graph contribute to an agent that searches?" with a number.
 *
 * Bounded on every axis: the needle is a LITERAL, case-insensitive substring
 * (never a regex, so no pattern can backtrack), at most {@link MAX_MATCHES}
 * matching lines are returned, at most {@link MAX_FILES_SCANNED} files and
 * {@link MAX_FILE_BYTES} per file are read, and the walk never leaves the clone:
 * hidden directories and `node_modules` are skipped, a symlinked file is read
 * only when it resolves inside the clone, and a symlinked directory is never
 * descended into (#1810). Not offered to any production agent.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, JSONSchema, ToolContext, ToolResult } from "../../analysis/tools/types.js";
import { missingParamError } from "../../analysis/tools/arg-errors.js";

/** Matching lines returned per call, at most. */
export const MAX_MATCHES = 50;
/** Files read per call, at most. They count files IN SCOPE: with `pathContains` the walk is not bounded by it (#1819). */
export const MAX_FILES_SCANNED = 5000;
/** A larger file is skipped: generated or vendored, not something to grep. */
export const MAX_FILE_BYTES = 512 * 1024;
/** A matching line is cut to this many characters. */
const MAX_LINE_CHARS = 200;
/** The shortest needle accepted: a one-character needle matches everything. */
const MIN_NEEDLE_CHARS = 2;

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
      description: "Optional: only search files whose relative path contains this text.",
    },
  },
  required: ["text"],
};

interface GrepArgs {
  text: string;
  pathContains?: string;
}

function validateArgs(args: unknown): GrepArgs | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.text !== "string" || a.text.trim().length < MIN_NEEDLE_CHARS) return null;
  return {
    text: a.text.trim(),
    ...(typeof a.pathContains === "string" && a.pathContains.trim() !== ""
      ? { pathContains: a.pathContains.trim() }
      : {}),
  };
}

/** The files a walk found, and whether the cap left files unlisted. */
interface ListedFiles {
  files: string[];
  capped: boolean;
}

/**
 * Every regular file under `root` whose relative path contains `scope` (all
 * when absent), relative, in a stable order, at most `limit`; never outside
 * `root`. The cap counts files IN SCOPE, so a scoped search on a large clone
 * still reaches the files it asked for (#1810). So with `pathContains` set the
 * cap does NOT bound the walk: every directory is still listed, and only the
 * files that match the scope are counted against it (#1819).
 *
 * A symlinked DIRECTORY is never descended into (#1810): a link such as
 * `x -> ..` or `x -> .` would otherwise walk the same tree forever, and the cap
 * cannot stop a walk that keeps finding directories but no new files. A link
 * is followed only inside the clone, and the walk reaches a directory the link
 * points at by its real path, unless that directory is one the walk skips
 * (hidden, or `node_modules`): a link into one of those is no longer searched
 * at all (#1819). A symlinked FILE inside the clone is still read.
 */
async function listFiles(
  root: string,
  realRoot: string,
  limit: number,
  scope: string | undefined,
): Promise<ListedFiles> {
  const files: string[] = [];
  let capped = false;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (capped) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
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
      }
      if (!isFile) continue;
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (scope && !rel.toLowerCase().includes(scope)) continue;
      if (files.length >= limit) {
        capped = true;
        return;
      }
      files.push(rel);
    }
  }
  await walk(root);
  return { files, capped };
}

async function execute(
  args: unknown,
  context: ToolContext,
  maxFilesScanned: number,
): Promise<ToolResult> {
  const validated = validateArgs(args);
  if (!validated) {
    return {
      content: missingParamError({
        tool: "grep_files",
        param: "text",
        expected: `literal text of at least ${MIN_NEEDLE_CHARS} characters`,
        args,
        example: "refreshFeed",
      }),
      isError: true,
    };
  }
  if (!context.cloneDir) {
    return {
      content: "Error: No repository clone directory configured for this project.",
      isError: true,
    };
  }
  let realRoot: string;
  try {
    realRoot = await fs.realpath(context.cloneDir);
  } catch {
    return { content: "Error: Repository clone directory not found.", isError: true };
  }
  const needle = validated.text.toLowerCase();
  const scope = validated.pathContains?.toLowerCase();
  const { files, capped } = await listFiles(context.cloneDir, realRoot, maxFilesScanned, scope);
  const matches: string[] = [];
  for (const rel of files) {
    if (matches.length >= MAX_MATCHES) break;
    const full = path.join(context.cloneDir, rel);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || stat.size > MAX_FILE_BYTES) continue;
    const body = await fs.readFile(full, "utf8").catch(() => null);
    if (body === null || body.includes("\u0000")) continue; // unreadable or binary
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
      if (lines[i]!.toLowerCase().includes(needle)) {
        matches.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, MAX_LINE_CHARS)}`);
      }
    }
  }
  if (matches.length === 0) {
    // #1810 — a search the file cap cut short must not read as "absent".
    return capped
      ? {
          content:
            `No lines contain: ${validated.text} in the first ${maxFilesScanned} file(s) searched; ` +
            "more files were not searched. Narrow the search with pathContains.",
          truncated: true,
          resultCount: 0,
        }
      : { content: `No lines contain: ${validated.text}`, resultCount: 0 };
  }
  return {
    content: matches.join("\n"),
    truncated: capped || matches.length >= MAX_MATCHES,
    resultCount: matches.length,
  };
}

/** The tool with its file cap; tests lower the cap instead of writing thousands of files. */
export function createGrepFilesTool(opts: { maxFilesScanned?: number } = {}): AgentTool {
  const maxFilesScanned = opts.maxFilesScanned ?? MAX_FILES_SCANNED;
  return {
    name: "grep_files",
    description:
      "Search the repository's files for a literal text (case-insensitive). Returns up to 50 " +
      "matching lines as `path:line: text`. Use it to find where a name or phrase appears, then " +
      "read_file_slice to read around a match.",
    parameters,
    execute: (args, context) => execute(args, context, maxFilesScanned),
  };
}

export const grepFilesTool: AgentTool = createGrepFilesTool();
