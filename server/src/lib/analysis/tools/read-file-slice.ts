/**
 * Epic #473 / Issue #475 — read_file_slice tool.
 *
 * Reads a range of lines from a file in the cloned repository. Enforces
 * path containment (SSRF prevention) and a 200-line-per-call limit. Secrets
 * in the file are replaced in place before any line is returned (#2333);
 * chat's `read_file_slice` wraps this tool, so it inherits that.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, ToolContext, ToolResult, JSONSchema } from "./types.js";
import { missingParamError } from "./arg-errors.js";
import { isHiddenInClone } from "./code-access.js";
import { redactSecrets } from "../../safety/secret-patterns.js";

/** Lines per call: production's cap for every caller of {@link readFileSliceTool}. */
export const MAX_LINES = 200;

/** A repository-relative path as the index stores it: `/`-separated, no `./` or leading `/`. */
function repoRelative(filePath: string): string {
  return path.posix
    .normalize(filePath.replace(/\\/g, "/"))
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");
}

export interface ReadFileSliceArgs {
  filePath: string;
  startLine?: number;
  endLine?: number;
}

const parameters: JSONSchema = {
  type: "object",
  properties: {
    filePath: {
      type: "string",
      description: "Relative path to the file within the repository clone",
    },
    startLine: {
      type: "number",
      description: "1-based start line (inclusive). Defaults to 1.",
    },
    endLine: {
      type: "number",
      description: "1-based end line (inclusive). Defaults to startLine + 199.",
    },
  },
  required: ["filePath"],
};

/** The same schema, with the default end line that a cap of `maxLines` implies. */
function parametersFor(maxLines: number): JSONSchema {
  if (maxLines === MAX_LINES) return parameters;
  return {
    ...parameters,
    properties: {
      ...parameters.properties,
      endLine: {
        type: "number",
        description: `1-based end line (inclusive). Defaults to startLine + ${maxLines - 1}.`,
      },
    },
  };
}

function validateArgs(args: unknown): ReadFileSliceArgs | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.filePath !== "string" || a.filePath.trim() === "") return null;
  return {
    filePath: a.filePath,
    startLine: typeof a.startLine === "number" ? Math.max(1, Math.floor(a.startLine)) : undefined,
    endLine: typeof a.endLine === "number" ? Math.max(1, Math.floor(a.endLine)) : undefined,
  };
}

/**
 * Validate that the resolved path is within the allowed clone directory.
 * Prevents path traversal attacks (e.g., ../../etc/passwd).
 * Uses fs.realpath() to resolve symlinks before containment check.
 */
async function resolveSafePath(cloneDir: string, relativePath: string): Promise<string | null> {
  const resolved = path.resolve(cloneDir, relativePath);
  const normalizedClone = path.resolve(cloneDir);
  if (!resolved.startsWith(normalizedClone + path.sep) && resolved !== normalizedClone) {
    return null;
  }

  // Follow symlinks and re-check containment to prevent symlink escape
  let realResolved: string;
  try {
    realResolved = await fs.realpath(resolved);
  } catch {
    // File doesn't exist — lexical check is sufficient for ENOENT
    return resolved;
  }
  const realClone = await fs.realpath(normalizedClone);
  if (!realResolved.startsWith(realClone + path.sep) && realResolved !== realClone) {
    return null;
  }
  return realResolved;
}

/** The reply's prefix when the file is not in the clone. */
export const FILE_NOT_FOUND = "Error: File not found:";

/**
 * #2329 — a repository file's lines, read from a clone with the containment and
 * symlink-escape checks above, with secrets redacted in place (#2333). Shared by
 * `read_file_slice` and `search_code_context`, so both refuse exactly the same
 * paths with the same replies and neither can return a secret.
 */
export async function readCloneFileLines(
  cloneDir: string,
  filePath: string,
  /** #2412 — refuse a file larger than this many bytes before reading it (`tooLarge`). */
  opts: { maxBytes?: number } = {},
): Promise<{ lines: string[] } | { error: string; tooLarge?: true }> {
  const absPath = await resolveSafePath(cloneDir, filePath);
  if (!absPath) {
    return { error: "Error: Path traversal detected. filePath must be within the repository." };
  }
  try {
    if (opts.maxBytes !== undefined) {
      const { size } = await fs.stat(absPath);
      if (size > opts.maxBytes) {
        return {
          error: `Error: ${filePath} is ${size} bytes, over the ${opts.maxBytes}-byte limit.`,
          tooLarge: true,
        };
      }
    }
    // #2333 — secrets out of the WHOLE file before any caller slices it, so a
    // key block that starts above a requested range is still recognised. In
    // place: every line keeps its number, so headers, numbering and citation
    // ranges are unchanged. Here, not in a caller, so no read path can miss it.
    return { lines: redactSecrets(await fs.readFile(absPath, "utf-8")).text.split("\n") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { error: `${FILE_NOT_FOUND} ${filePath}` };
    if (code === "EISDIR") return { error: `Error: Path is a directory, not a file: ${filePath}` };
    return { error: `Error reading file: ${(err as Error).message}` };
  }
}

async function execute(
  args: unknown,
  context: ToolContext,
  maxLines: number = MAX_LINES,
  /** #2565 — characters of numbered lines per call, at most; unset ⇒ lines alone bound a read. */
  maxChars?: number,
): Promise<ToolResult> {
  const validated = validateArgs(args);
  if (!validated) {
    // #774 — a rejection the model can repair from: it names what arrived.
    return {
      content: missingParamError({
        tool: "read_file_slice",
        param: "filePath",
        expected: "non-empty string, relative to the repository root",
        args,
        example: "server/src/index.ts",
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

  // #2314 — the analysis code agent's caller may not see every file (#2243): a
  // hidden one gets the reply a missing file gets, so no reply confirms that a
  // restricted file exists. Chat's wrapper checks before it calls this tool.
  const access = context.codeAccess;
  if (
    access &&
    !access.unrestricted &&
    (await isHiddenInClone(
      access,
      context.connectorId ?? null,
      context.cloneDir,
      validated.filePath,
    ))
  ) {
    return { content: `${FILE_NOT_FOUND} ${validated.filePath}`, isError: true };
  }

  const read = await readCloneFileLines(context.cloneDir, validated.filePath);
  if ("error" in read) return { content: read.error, isError: true };

  const lines = read.lines;
  const startLine = validated.startLine ?? 1;
  let endLine = validated.endLine ?? startLine + maxLines - 1;

  // Enforce max lines per call
  const capped = endLine - startLine + 1 > maxLines;
  if (capped) {
    endLine = startLine + maxLines - 1;
  }

  // Clamp to file length
  let clampedEnd = Math.min(endLine, lines.length);
  let slice = lines.slice(startLine - 1, clampedEnd);
  // #2565 — a size cap per read, not only a line cap: 1000 long lines are far
  // more than one tool result should carry (a result is re-sent every turn
  // until compaction elides it). The first line is always kept, cut to the cap.
  let charCapped = false;
  /** The full length of a first line cut at `maxChars`, else 0. */
  let lineCut = 0;
  if (maxChars !== undefined && slice.length > 0) {
    let used = 0;
    let kept = 0;
    for (const line of slice) {
      const cost = `${startLine + kept}| ${line}`.length + 1;
      if (used + cost > maxChars && kept > 0) break;
      used += cost;
      kept += 1;
    }
    if (kept < slice.length) {
      charCapped = true;
      slice = slice.slice(0, kept);
      clampedEnd = startLine + kept - 1;
    }
    // A line longer than the cap (a minified bundle) is cut too, and says so:
    // silently cutting it reported a partial line as a complete read.
    if (slice[0]!.length > maxChars) {
      lineCut = slice[0]!.length;
      slice = [slice[0]!.slice(0, maxChars)];
    }
  }
  // #726 — truncated means "you did not get what you asked for": the per-call
  // cap cut an explicit range, or an open-ended read stopped before the end of
  // the file. An explicit range that lies inside the file (or runs past its
  // end) was answered in full; flagging it appended "[Results truncated]" to
  // every symbol-sized read, and the agent reported fully-read functions as
  // cut off. The header still says "lines X-Y of N" either way.
  const truncated =
    lineCut > 0 ||
    (validated.endLine === undefined
      ? clampedEnd < lines.length
      : (capped || charCapped) && clampedEnd < lines.length);

  // #773 — an OUT-OF-RANGE read is a BAD CALL, not a fact about the codebase. If it
  // returned `resultCount: 0` it would be indistinguishable from a well-formed empty
  // result, which under the evidence threshold means "the tool worked and the thing
  // genuinely is not there" — an inference this call cannot support.
  if (slice.length === 0) {
    return {
      content: `Error: startLine ${startLine} is past the end of ${validated.filePath} (${lines.length} lines).`,
      isError: true,
    };
  }

  const numbered = slice.map((line, i) => `${startLine + i}| ${line}`);
  const header = `${validated.filePath} (lines ${startLine}-${clampedEnd} of ${lines.length})`;
  // #2325 — a cut read names the range to ask for next. In the HEAD, before the
  // lines: chat caps the model's copy of a result by keeping its start
  // (`capForModel`, #138), and a 200-line read is routinely longer than that
  // cap, so a hint after the lines would be cut away with them.
  const next =
    truncated && clampedEnd < lines.length
      ? { startLine: clampedEnd + 1, endLine: Math.min(clampedEnd + maxLines, lines.length) }
      : undefined;
  const lineNote = lineCut
    ? `\n[Line ${startLine} cut at ${maxChars} of its ${lineCut} characters; the rest of that line cannot be read through this tool.]`
    : "";
  const paging = next
    ? charCapped
      ? `\n[Cut at ${maxChars} characters per call: request lines ${next.startLine}-${next.endLine} next.]`
      : `\n[Cut at ${maxLines} lines per call: request lines ${next.startLine}-${next.endLine} next.]`
    : "";

  return {
    content: `${header}${lineNote}${paging}\n${numbered.join("\n")}`,
    truncated,
    resultCount: slice.length,
    // #2325 — the citation contract. The version is the caller's to state: this
    // tool reads a directory and knows no commit, nor which repository it is.
    citations: [
      {
        repoConnectionId: null,
        path: repoRelative(validated.filePath),
        startLine,
        endLine: clampedEnd,
        commitSha: null,
        permalink: null,
        truncated,
        totalLines: lines.length,
        ...(next ? { next } : {}),
        stale: false,
      },
    ],
  };
}

export const readFileSliceTool: AgentTool = {
  name: "read_file_slice",
  description:
    "Read a range of lines from a file in the repository. Returns numbered lines. " +
    "Max 200 lines per call. Use search_code_graph first to identify relevant files and line ranges.",
  parameters,
  execute: (args, context) => execute(args, context, MAX_LINES),
};

/**
 * #2560 — `read_file_slice` with another per-call line cap, which may read a
 * whole file in one call: the eval's explorer arm (A20) and, since #2565, the
 * analysis code pass in `explore` mode. `maxChars` (#2565) caps a read by size
 * too; a read it cuts is `truncated` and names the next range. Every check
 * (containment, symlink escape, hidden files, secret redaction) is the same
 * code as {@link readFileSliceTool}'s.
 */
export function createReadFileSliceTool(
  maxLines: number,
  opts: { maxChars?: number } = {},
): AgentTool {
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error(`read_file_slice: maxLines must be a positive integer, not ${maxLines}`);
  }
  const { maxChars } = opts;
  if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 1)) {
    throw new Error(`read_file_slice: maxChars must be a positive integer, not ${maxChars}`);
  }
  return {
    name: readFileSliceTool.name,
    description:
      "Read a file, or a range of its lines, from the repository. Returns numbered lines. " +
      `Omit startLine and endLine to read the whole file; max ${maxLines} lines` +
      (maxChars !== undefined ? ` and ${maxChars} characters` : "") +
      " per call.",
    parameters: parametersFor(maxLines),
    execute: (args, context) => execute(args, context, maxLines, maxChars),
  };
}
