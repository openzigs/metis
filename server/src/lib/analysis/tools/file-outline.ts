/**
 * #2346 — `get_file_outline`: the symbols one file declares, from the code
 * graph, without reading the file.
 *
 * Each symbol is listed with its kind, its `path:start-end` span and the
 * symbol it is declared in (read off its qualified name,
 * `path::Class::method`), in source order and indented under that parent, so
 * the model can pick the span to read with `read_file_slice` rather than
 * paging the file. A file in no code graph (a language the graph does not
 * parse, or a file the ingest skipped) is said to be so, never answered with
 * an empty outline.
 *
 * Offered in chat behind `CHAT_FILE_OUTLINE_TOOL` (off by default, until it is
 * measured as #2327 and #2329 were). Read-only and project-scoped:
 *   - the path is a repository-relative one (`checkRepoGlob`: no absolute path,
 *     no `..`, no control character) and is matched exactly against the code
 *     graph's rows of the session's project, so nothing outside the project's
 *     indexed repositories is reachable (A03);
 *   - a file whose document is hidden from the caller (#2243) reads exactly as
 *     a file the graph does not hold, so the outline is no existence oracle (A01);
 *   - credential files and git internals are refused as `read_file_slice`
 *     refuses them;
 *   - every listed symbol carries the #2325 citation contract, and the result
 *     opens with the commit it describes.
 * It returns names, kinds and line numbers only, never the file's text.
 */
import type { CodeCitationRef } from "@metis/shared";
import type { AgentTool, JSONSchema, ToolContext, ToolResult } from "./types.js";
import { missingParamError } from "./arg-errors.js";
import { checkRepoGlob, isSensitiveRepoPath, notAccessible, repoPathError } from "./repo-paths.js";
import { normalizeRepoPath } from "./code-access.js";
import { prisma } from "../../prisma.js";
import { detectLanguage } from "../../code-graph/parsers.js";
import {
  codeCitationRef,
  formatCodeVersionLine,
  loadCodeVersions,
  type CodeVersionIndex,
} from "../../code-graph/code-version.js";

export const FILE_OUTLINE_TOOL_NAME = "get_file_outline";
/** The most symbols one outline lists; the rest are counted, with where to read on. */
export const MAX_OUTLINE_SYMBOLS = 200;
/** Rows read per call: a generated file can declare thousands of symbols. */
const MAX_OUTLINE_ROWS = 2000;

const parameters: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Repository-relative path of one file, e.g. 'internal/reader/handler.go' (no glob).",
    },
  },
  required: ["path"],
};

/** One symbol of an outline. */
export interface OutlineSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** The symbol it is declared in, by name; `null` at the top of the file. */
  parent: string | null;
  /** How many symbols it is nested in. */
  depth: number;
}

/**
 * The parent and depth of a symbol, from its qualified name: everything
 * between the file's `path::` prefix and its own name. A qualified name that
 * does not start with the path (a schema symbol, `schema.table.column`) is
 * top-level.
 */
export function parentOf(
  qualifiedName: string,
  filePath: string,
): { parent: string | null; depth: number } {
  const prefix = `${filePath}::`;
  if (!qualifiedName.startsWith(prefix)) return { parent: null, depth: 0 };
  const chain = qualifiedName.slice(prefix.length).split("::");
  if (chain.length < 2) return { parent: null, depth: 0 };
  return { parent: chain[chain.length - 2]!, depth: chain.length - 1 };
}

interface Row {
  name: string;
  kind: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  language: string;
  graph: { repoConnectionId: string | null; repoConnection: { label: string } | null };
}

/** Injectable for tests. */
export interface FileOutlineDeps {
  loadVersions: (projectId: string) => Promise<CodeVersionIndex>;
}

function notInGraph(filePath: string): ToolResult {
  const why =
    detectLanguage(filePath) === null
      ? "the code graph does not parse files of this type"
      : "no file at this path was indexed: it may not exist, or the indexing skipped it " +
        "(too large, unreadable, excluded, or added after the last indexing)";
  return {
    content:
      `${JSON.stringify(filePath)} is not in this project's code graph: ${why}. ` +
      "There is no outline to give; read_file_slice can still read a file that exists.",
    resultCount: 0,
  };
}

export function createFileOutlineTool(deps: Partial<FileOutlineDeps> = {}): AgentTool {
  const loadVersions = deps.loadVersions ?? loadCodeVersions;

  async function execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const raw = (args as { path?: unknown } | null)?.path;
    if (typeof raw !== "string" || raw.trim() === "") {
      return {
        content: missingParamError({
          tool: FILE_OUTLINE_TOOL_NAME,
          param: "path",
          expected: "non-empty repository-relative file path",
          args,
          example: "internal/reader/handler.go",
        }),
        isError: true,
      };
    }
    const checked = checkRepoGlob(raw);
    if (!checked.ok) {
      return {
        content: repoPathError(FILE_OUTLINE_TOOL_NAME, "path", checked.reason),
        isError: true,
      };
    }
    const filePath = normalizeRepoPath(checked.value);
    if (isSensitiveRepoPath(filePath)) return { content: notAccessible(filePath), isError: true };

    const rows: Row[] = await prisma.codeSymbol.findMany({
      where: { projectId: ctx.projectId, filePath },
      select: {
        name: true,
        kind: true,
        qualifiedName: true,
        startLine: true,
        endLine: true,
        language: true,
        graph: { select: { repoConnectionId: true, repoConnection: { select: { label: true } } } },
      },
      orderBy: [{ startLine: "asc" }, { endLine: "desc" }, { id: "asc" }],
      take: MAX_OUTLINE_ROWS,
    });
    // #2243 — a hidden file is answered as one the graph does not hold.
    const access = ctx.codeAccess;
    const visible = access
      ? rows.filter((r) => !access.isHidden(r.graph.repoConnectionId, filePath))
      : rows;
    if (visible.length === 0) return notInGraph(filePath);

    // One block per repository holding the file (usually one).
    const byRepo = new Map<string | null, Row[]>();
    for (const r of visible) {
      const key = r.graph.repoConnectionId;
      const list = byRepo.get(key) ?? [];
      list.push(r);
      byRepo.set(key, list);
    }
    const versions = await loadVersions(ctx.projectId);
    const citations: CodeCitationRef[] = [];
    const blocks: string[] = [];
    let listed = 0;
    let total = 0;
    let truncated = rows.length >= MAX_OUTLINE_ROWS;
    for (const [repoId, repoRows] of byRepo) {
      // The `module` row stands for the file itself: it says the file is
      // indexed and in which language, and is not one of its symbols.
      const symbols = repoRows.filter((r) => r.kind !== "module");
      total += symbols.length;
      const language = repoRows[0]!.language;
      const label = repoRows[0]!.graph.repoConnection?.label;
      const where =
        byRepo.size > 1 && label ? ` in repository ${JSON.stringify(label.slice(0, 200))}` : "";
      if (symbols.length === 0) {
        blocks.push(
          `${filePath}${where} (${language}) is in the code graph and declares no functions, classes or other symbols.`,
        );
        continue;
      }
      const room = Math.max(0, MAX_OUTLINE_SYMBOLS - listed);
      const shown = symbols.slice(0, room);
      listed += shown.length;
      const lines = shown.map((r) => {
        const { parent, depth } = parentOf(r.qualifiedName, filePath);
        citations.push(
          codeCitationRef({
            repoConnectionId: repoId,
            path: filePath,
            startLine: r.startLine,
            endLine: r.endLine,
            version: versions.forRepo(repoId),
          }),
        );
        const indent = "  ".repeat(Math.min(depth, 6));
        const inParent = parent ? ` (in ${parent})` : "";
        return `${indent}- ${r.kind} ${r.name} — ${filePath}:${r.startLine}-${r.endLine}${inParent}`;
      });
      let head = `Outline of ${filePath}${where} (${language}, ${symbols.length} symbol(s)):`;
      if (shown.length === 0) {
        // An earlier repository's block used every slot of the cap.
        truncated = true;
        head =
          `Outline of ${filePath}${where} (${language}): ${symbols.length} symbol(s), not listed: ` +
          `the outline's cap of ${MAX_OUTLINE_SYMBOLS} symbols was reached; they start at line ${symbols[0]!.startLine}.`;
      } else if (shown.length < symbols.length) {
        truncated = true;
        const next = symbols[shown.length]!;
        head += ` the first ${shown.length} are listed; the rest start at line ${next.startLine}.`;
      }
      blocks.push([head, ...lines].join("\n"));
    }

    const version = formatCodeVersionLine(citations);
    const body = blocks.join("\n\n");
    return {
      content: version ? `${version}\n\n${body}` : body,
      resultCount: total,
      ...(truncated ? { truncated: true } : {}),
      citations,
    };
  }

  return {
    name: FILE_OUTLINE_TOOL_NAME,
    description:
      "List the symbols one file declares (functions, classes, methods, types) with their kind, " +
      "path:start-end span and the symbol each is declared in, from the project's code graph, " +
      "without reading the file. Use it to find which lines of a file to read with read_file_slice. " +
      "Says so when the file is not in the code graph.",
    parameters,
    execute,
  };
}
