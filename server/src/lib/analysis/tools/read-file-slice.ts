/**
 * Epic #473 / Issue #475 — read_file_slice tool.
 *
 * Reads a range of lines from a file in the cloned repository. Enforces
 * path containment (SSRF prevention) and a 200-line-per-call limit.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, ToolContext, ToolResult, JSONSchema } from "./types.js";
import { missingParamError } from "./arg-errors.js";

const MAX_LINES = 200;

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

async function execute(args: unknown, context: ToolContext): Promise<ToolResult> {
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

  const absPath = await resolveSafePath(context.cloneDir, validated.filePath);
  if (!absPath) {
    return {
      content: "Error: Path traversal detected. filePath must be within the repository.",
      isError: true,
    };
  }

  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { content: `Error: File not found: ${validated.filePath}`, isError: true };
    }
    if (code === "EISDIR") {
      return {
        content: `Error: Path is a directory, not a file: ${validated.filePath}`,
        isError: true,
      };
    }
    return { content: `Error reading file: ${(err as Error).message}`, isError: true };
  }

  const lines = content.split("\n");
  const startLine = validated.startLine ?? 1;
  let endLine = validated.endLine ?? startLine + MAX_LINES - 1;

  // Enforce max lines per call
  if (endLine - startLine + 1 > MAX_LINES) {
    endLine = startLine + MAX_LINES - 1;
  }

  // Clamp to file length
  const clampedEnd = Math.min(endLine, lines.length);
  const slice = lines.slice(startLine - 1, clampedEnd);
  const truncated = clampedEnd < endLine || clampedEnd < lines.length;

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

  return {
    content: `${header}\n${numbered.join("\n")}`,
    truncated,
    resultCount: slice.length,
  };
}

export const readFileSliceTool: AgentTool = {
  name: "read_file_slice",
  description:
    "Read a range of lines from a file in the repository. Returns numbered lines. " +
    "Max 200 lines per call. Use search_code_graph first to identify relevant files and line ranges.",
  parameters,
  execute,
};
