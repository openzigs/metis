/**
 * Epic #473 / Issue #475 — list_files tool.
 *
 * Globs the clone directory to let the agent discover files. Returns up to
 * 100 results.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, ToolContext, ToolResult, JSONSchema } from "./types.js";
import { missingParamError } from "./arg-errors.js";

const MAX_RESULTS = 100;

export interface ListFilesArgs {
  pattern: string;
}

const parameters: JSONSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        "Glob pattern to match files (e.g., 'src/**/*.ts', '*.json'). " +
        "Uses simple path matching — not full minimatch.",
    },
  },
  required: ["pattern"],
};

function validateArgs(args: unknown): ListFilesArgs | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.pattern !== "string" || a.pattern.trim() === "") return null;
  return { pattern: a.pattern };
}

/**
 * Simple recursive file listing with pattern matching.
 * Uses basic glob-like matching (supports * and **).
 * Rejects symlinks that resolve outside the clone directory.
 */
async function walkDir(
  dir: string,
  baseDir: string,
  pattern: RegExp,
  results: string[],
): Promise<void> {
  if (results.length >= MAX_RESULTS) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;

    // Skip hidden dirs and common non-source directories
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const fullPath = path.join(dir, entry.name);

    // Reject symlinks that escape the clone directory
    const stat = await fs.lstat(fullPath).catch(() => null);
    if (stat?.isSymbolicLink()) {
      let realTarget: string;
      try {
        realTarget = await fs.realpath(fullPath);
      } catch {
        continue; // broken symlink — skip
      }
      const realBase = await fs.realpath(baseDir);
      if (!realTarget.startsWith(realBase + path.sep) && realTarget !== realBase) {
        continue; // symlink escapes clone dir — skip
      }
    }

    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      await walkDir(fullPath, baseDir, pattern, results);
    } else if (entry.isFile() && pattern.test(relativePath)) {
      results.push(relativePath);
    }
  }
}

/**
 * Convert a simple glob pattern to a regex.
 * Supports: * (single segment), ** (multi-segment including zero), ? (single char)
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      // ** — match zero or more path segments
      // Consume any surrounding slashes
      i += 2;
      if (pattern[i] === "/") i++;
      regex += "(?:.*/)?";
    } else if (ch === "*") {
      regex += "[^/]*";
      i++;
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(ch)) {
      regex += "\\" + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- every regex metacharacter is escaped before only `*`/`?`/`**` are expanded into bounded classes; the anchored result is linear-time, so no injection or ReDoS is possible.
  return new RegExp(`^${regex}$`);
}

async function execute(args: unknown, context: ToolContext): Promise<ToolResult> {
  const validated = validateArgs(args);
  if (!validated) {
    // #774 — name the received keys so the model can self-repair in one turn.
    return {
      content: missingParamError({
        tool: "list_files",
        param: "pattern",
        expected: "non-empty glob string",
        args,
        example: "src/**/*.ts",
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

  // Validate clone dir exists
  try {
    await fs.access(context.cloneDir);
  } catch {
    return { content: "Error: Repository clone directory not found.", isError: true };
  }

  const regex = globToRegex(validated.pattern);
  const results: string[] = [];
  await walkDir(context.cloneDir, context.cloneDir, regex, results);

  if (results.length === 0) {
    return { content: `No files matching pattern: ${validated.pattern}`, resultCount: 0 };
  }

  const truncated = results.length === MAX_RESULTS;
  return {
    content: results.join("\n"),
    truncated,
    resultCount: results.length,
  };
}

export const listFilesTool: AgentTool = {
  name: "list_files",
  description:
    "List files in the repository matching a glob pattern. Returns relative file paths. " +
    "Max 100 results. Use to discover project structure before reading specific files.",
  parameters,
  execute,
};
