/**
 * #2329 — `search_code_context`: an answer-oriented first call for a code
 * question, returning WHOLE functions rather than fragments.
 *
 * Chat sees 10-line symbol snippets (`search_code_symbols`) or 2 KB chunks, and
 * reading a whole function costs a `read_file_slice` turn. This tool runs the
 * SAME ranked search `search_code_symbols` runs (the same searcher, retrievers
 * and weights: ranking is unchanged, ADR 0020) and changes only what is
 * returned for the hits:
 *
 *   1. each hit is a code-graph symbol, so it is already widened to its
 *      symbol's span (`SymbolLineLookup`, the `CodeSymbol` row);
 *   2. hits in one file whose spans overlap or sit within `mergeGap` lines are
 *      merged into one span (`mergeAdjacentSpans`), so no line is returned twice
 *      and a method inside a matched class is not repeated;
 *   3. each span's lines are read from the repository's clone through the same
 *      checks `read_file_slice` makes (containment, symlink escape, git
 *      internals and credential files, the caller's document ACLs);
 *   4. a span longer than `maxSpanLines` is returned as its signature (first
 *      lines) plus the matched window(s), with `truncated` and `totalLines` set
 *      and the next range to read named;
 *   5. spans are placed best-ranked first while they fit `tokenBudget`. A
 *      span larger than what is left is cut down to fit (signature first, the
 *      range to read next named), never skipped silently; one that cannot fit
 *      even its signature is COUNTED in the notes, never named by locator: the
 *      #2242 citation verifier reads every `path:a-b` in a code tool's text as
 *      lines that were read, so a locator for an unreturned span would let an
 *      answer citing it pass as verified.
 *
 * A hit whose code graph names no repository (a legacy graph, `repoConnectionId`
 * null) is read as `search_code_symbols` and chat's `read_file_slice` read it:
 * its version is the project's only graph's (`forRepo(null)`), and its file is
 * read from the first of the project's clones that has it, under that clone's
 * checks.
 *
 * The notes (the version line, a stale warning, left-out spans) come BEFORE
 * the spans, as #2325 placed them on every chat code tool: chat caps the
 * model's copy of a result by keeping its start (`capForModel`), so a note
 * after the spans would be the first thing cut.
 *
 * It is NOT a re-chunking of the document store (ADR 0002 stands): it is
 * assembled at query time from the symbol index and the clone. Every span
 * carries the #2325 citation contract.
 *
 * OWASP: A01 — a hit whose file the caller may not see is dropped BEFORE
 * merging (`hiddenSymbolIds`), so a merged span never bridges into a hidden
 * file, and the clone path is checked again where the read really resolves
 * (`isHiddenInClone`, with the id of the clone actually read). Git internals
 * and credential files are refused as `read_file_slice` refuses them
 * (`isSensitiveInClone`: as named AND where the path really resolves). A03 — line ranges come from `CodeSymbol` rows, are
 * clamped to the file, and no path comes from model text.
 *
 * Off by default (`CHAT_CODE_CONTEXT_TOOL`): it becomes a default chat tool
 * only once the paired `pnpm eval:ba-qa` arms show turns per answer falling
 * without facts stated or citation precision regressing. It is a good first
 * call, never the only one: the other code tools stay offered beside it.
 */
import type { CodeCitationRef, RetrievalMatcher } from "@metis/shared";
import type { AgentTool, JSONSchema, ToolContext, ToolResult } from "./types.js";
import { missingParamError } from "./arg-errors.js";
import { hiddenSymbolIds, UNRESTRICTED_CODE_ACCESS } from "./code-access.js";
import { readCloneFileLines } from "./read-file-slice.js";
import {
  cloneStaleness,
  isHiddenInClone,
  readCloneHead,
  staleNote,
} from "./chat-read-file-slice.js";
import { isSensitiveInClone, isSensitiveRepoPath } from "./repo-paths.js";
import { resolveChatClones, type ChatCloneDeps } from "./chat-clones.js";
import { resolveExistingCloneDir } from "../clone-availability.js";
import {
  mergeAdjacentSpans,
  type FusedCodeSearcher,
  type LocatedHit,
  type MergedSpan,
  type SymbolLineLookup,
} from "../../rag/fused-code-context.js";
import {
  codeCitationRef,
  formatCodeVersionLine,
  loadCodeVersions,
  type CodeVersionIndex,
} from "../../code-graph/code-version.js";
import {
  createDefaultCodeSearcher,
  createDefaultSymbolLineLookup,
} from "../../code-graph/project-code-searcher.js";

export const SEARCH_CODE_CONTEXT_TOOL = "search_code_context";
/** Spans returned when the call names no `limit`. */
export const DEFAULT_SPANS = 6;
/** The most spans one call returns, however large a `limit` it passes. */
export const MAX_SPANS = 12;
/**
 * How many ranked hits are read to build the spans: the same depth as
 * `search_code_symbols`'s default, so the hits are the ones it would list.
 */
export const SEARCH_DEPTH = 15;
/** Two hits this many lines apart (or closer) in one file become one span. */
export const DEFAULT_MERGE_GAP = 3;
/** The longest span returned whole. */
export const DEFAULT_MAX_SPAN_LINES = 120;
/** The whole result's budget, in tokens (4 characters each, as the fused block). */
export const DEFAULT_TOKEN_BUDGET = 4000;
/** Lines of a cut span kept as its signature. */
const SIGNATURE_LINES = 4;
const CHARS_PER_TOKEN = 4;
/** The fewest lines a span is cut down to before it is left out: its signature and one more. */
const MIN_FITTED_LINES = SIGNATURE_LINES + 1;

const parameters: JSONSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Natural-language or keyword question about the code. Ranked exactly as search_code_symbols ranks it.",
    },
    limit: {
      type: "number",
      description: `Maximum spans to return (1-${MAX_SPANS}, default ${DEFAULT_SPANS}).`,
    },
  },
  required: ["query"],
};

export interface SearchCodeContextDeps {
  searcher: FusedCodeSearcher;
  lineLookup: SymbolLineLookup;
  loadVersions: (projectId: string) => Promise<CodeVersionIndex>;
  /** A connector's clone dir, only when it exists and is readable. */
  resolveCloneDir: (connectorId: string) => Promise<string | undefined>;
  /**
   * The project's live repo connections, in search order: where a hit from a
   * graph that names no repository is looked for (`resolveChatClones`).
   */
  listRepoIds: NonNullable<ChatCloneDeps["listRepoIds"]>;
  readHead: (cloneDir: string) => Promise<string | null>;
  mergeGap: number;
  maxSpanLines: number;
  tokenBudget: number;
}

interface Hit extends LocatedHit {
  /** `null`: a legacy graph that names no repository. */
  repoId: string | null;
  path: string;
  name: string;
  kind: string;
  matchedBy?: RetrievalMatcher[];
}

/** The line ranges of a span that are returned, and what was cut. */
interface Plan {
  ranges: Array<[number, number]>;
  truncated: boolean;
  next?: { startLine: number; endLine: number };
}

/**
 * Which lines of `span` (already clamped to the file) are returned: all of
 * them when it fits `maxLines`; else its signature plus the windows of the
 * hits inside it, best-ranked first, while they fit, then the lines after the
 * signature. The first range left out is the next to read.
 */
export function planSpanLines(
  span: {
    startLine: number;
    endLine: number;
    hits: ReadonlyArray<{ startLine: number; endLine: number }>;
  },
  maxLines: number,
): Plan {
  const { startLine, endLine } = span;
  if (endLine - startLine + 1 <= maxLines)
    return { ranges: [[startLine, endLine]], truncated: false };
  const keep = new Set<number>();
  const take = (a: number, b: number) => {
    for (
      let n = Math.max(a, startLine);
      n <= Math.min(b, endLine) && keep.size < maxLines;
      n += 1
    ) {
      keep.add(n);
    }
  };
  take(startLine, startLine + SIGNATURE_LINES - 1);
  // The matched windows: hits that are not the whole span (a method in a class).
  for (const h of span.hits) {
    if (h.startLine <= startLine && h.endLine >= endLine) continue;
    take(h.startLine, h.endLine);
  }
  take(startLine, endLine); // what budget is left: the body after the signature
  const lines = [...keep].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const n of lines) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === n - 1) last[1] = n;
    else ranges.push([n, n]);
  }
  let gapStart = startLine;
  for (const [a, b] of ranges) {
    if (a > gapStart) break;
    gapStart = b + 1;
  }
  const gapEnd =
    Math.min(ranges.find(([a]) => a > gapStart)?.[0] ?? endLine + 1, gapStart + 200) - 1;
  return {
    ranges,
    truncated: true,
    ...(gapStart <= endLine
      ? { next: { startLine: gapStart, endLine: Math.min(gapEnd, endLine) } }
      : {}),
  };
}

function validateArgs(args: unknown): { query: string; limit: number } | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.query !== "string" || a.query.trim() === "") return null;
  const limit =
    typeof a.limit === "number" && Number.isFinite(a.limit)
      ? Math.min(Math.max(1, Math.floor(a.limit)), MAX_SPANS)
      : DEFAULT_SPANS;
  return { query: a.query, limit };
}

function spanLabel(hits: readonly Hit[]): string {
  const named = hits.slice(0, 3).map((h) => `${h.kind} ${h.name}`);
  return hits.length > 3 ? `${named.join(", ")}, +${hits.length - 3} more` : named.join(", ");
}

function unionMatchers(hits: readonly Hit[]): RetrievalMatcher[] {
  const all = new Set(hits.flatMap((h) => h.matchedBy ?? []));
  return (["dense", "lexical"] as const).filter((m) => all.has(m));
}

export function createSearchCodeContextTool(deps: Partial<SearchCodeContextDeps> = {}): AgentTool {
  const searcher = deps.searcher ?? createDefaultCodeSearcher();
  const lineLookup = deps.lineLookup ?? createDefaultSymbolLineLookup();
  const loadVersions = deps.loadVersions ?? loadCodeVersions;
  const resolveCloneDir = deps.resolveCloneDir ?? resolveExistingCloneDir;
  const readHead = deps.readHead ?? readCloneHead;
  const mergeGap = Math.max(0, deps.mergeGap ?? DEFAULT_MERGE_GAP);
  const maxSpanLines = Math.max(SIGNATURE_LINES + 1, deps.maxSpanLines ?? DEFAULT_MAX_SPAN_LINES);
  const tokenBudget = deps.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

  async function execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const validated = validateArgs(args);
    if (!validated) {
      return {
        content: missingParamError({
          tool: SEARCH_CODE_CONTEXT_TOOL,
          param: "query",
          expected: "non-empty string",
          args,
          example: "how is a feed refreshed",
        }),
        isError: true,
      };
    }
    if (!context.projectId) {
      return { content: "Error: code context needs a project-scoped session.", isError: true };
    }
    const projectId = context.projectId;
    const access = context.codeAccess ?? UNRESTRICTED_CODE_ACCESS;

    const found = await searcher.search(validated.query, projectId, { limit: SEARCH_DEPTH });
    // A01 — hidden files are dropped BEFORE merging: a span never bridges into one.
    const hidden = await hiddenSymbolIds(
      access,
      projectId,
      found.map((r) => r.symbolId),
    );
    const visible = found.filter((r) => !hidden.has(r.symbolId));
    const located = await lineLookup.resolve(
      visible.map((r) => r.symbolId),
      projectId,
    );
    const hits: Hit[] = [];
    visible.forEach((r, rank) => {
      const span = located.get(r.symbolId);
      if (!span || isSensitiveRepoPath(span.filePath)) return;
      const repoId = span.repoConnectionId ?? null;
      hits.push({
        file: `${repoId ?? ""}\u0000${span.filePath}`,
        repoId,
        path: span.filePath,
        startLine: span.startLine,
        endLine: span.endLine,
        rank,
        name: r.name,
        kind: r.kind,
        ...(r.matchedBy ? { matchedBy: r.matchedBy } : {}),
      });
    });
    if (hits.length === 0) {
      return { content: "No matching code found in this project's code graph.", resultCount: 0 };
    }

    const spans = mergeAdjacentSpans(hits, mergeGap);
    const versions = await loadVersions(projectId);
    const clones = new Map<string, Promise<string | undefined>>();
    const cloneOf = (repoId: string) => {
      let dir = clones.get(repoId);
      if (!dir) clones.set(repoId, (dir = resolveCloneDir(repoId)));
      return dir;
    };
    let projectClones: ReturnType<typeof resolveChatClones> | undefined;
    const allClones = () =>
      (projectClones ??= resolveChatClones(projectId, {
        resolveCloneDir: cloneOf,
        ...(deps.listRepoIds ? { listRepoIds: deps.listRepoIds } : {}),
      }));
    /**
     * The span's file from the clone it is read from: its own repository's, or
     * (a graph naming none) the first of the project's clones that has it. A
     * clone where the path is a credential file or hidden from the caller, as
     * named or where it really resolves, is not read.
     */
    const readSpanFile = async (
      repoId: string | null,
      filePath: string,
    ): Promise<{ repoId: string; cloneDir: string; lines: string[] } | null> => {
      const candidates =
        repoId !== null ? [{ id: repoId, dir: await cloneOf(repoId) }] : await allClones();
      for (const { id, dir } of candidates) {
        if (!dir) continue;
        if (await isSensitiveInClone(dir, filePath)) continue;
        if (await isHiddenInClone(access, id, dir, filePath)) continue;
        const read = await readCloneFileLines(dir, filePath);
        if ("error" in read) continue;
        return { repoId: id, cloneDir: dir, lines: read.lines };
      }
      return null;
    };
    const staleness = new Map<string, Promise<{ stale: boolean; head: string | null }>>();

    const blocks: string[] = [];
    const citations: CodeCitationRef[] = [];
    const staleNotes = new Set<string>();
    let spent = 0;
    let notReturned = 0;
    let unreadable = 0;
    /** Spans left out because not even their signature fit the budget. Counted, never located. */
    let overBudget = 0;
    for (const span of spans) {
      if (blocks.length >= validated.limit) {
        notReturned += 1;
        continue;
      }
      const first = span.hits[0]!;
      const read = await readSpanFile(first.repoId, first.path);
      if (!read) {
        unreadable += 1;
        continue;
      }
      const { repoId, cloneDir } = read;
      // A03 — the span is clamped to the file as it is on disk.
      const total = read.lines.length;
      if (span.startLine > total) {
        // The file is shorter than the index says: it moved on. Not guessed at.
        unreadable += 1;
        continue;
      }
      const clamped = {
        startLine: Math.min(span.startLine, total),
        endLine: Math.min(span.endLine, total),
        hits: span.hits,
      };
      const fitted = fitSpan(clamped, maxSpanLines, tokenBudget - spent, (plan) =>
        renderSpan(blocks.length + 1, first.path, clamped, plan, read.lines, span),
      );
      if (!fitted) {
        overBudget += 1;
        continue;
      }
      const { plan, block, cost } = fitted;
      spent += cost;
      blocks.push(block);
      // A legacy graph's hit takes the project's only graph's version, as
      // search_code_symbols states it.
      const version = versions.forRepo(first.repoId);
      const key = `${first.repoId ?? ""}\u0000${repoId}`;
      let check = staleness.get(key);
      if (!check) staleness.set(key, (check = cloneStaleness(version, cloneDir, readHead)));
      const { stale, head } = await check;
      if (stale) staleNotes.add(staleNote(version.commitSha!, head));
      citations.push(
        codeCitationRef({
          // #2325 — a code citation is identified by repository AND path: the
          // repository the lines were read from.
          repoConnectionId: repoId,
          path: first.path,
          startLine: clamped.startLine,
          endLine: clamped.endLine,
          version,
          matchedBy: unionMatchers(span.hits),
          truncated: plan.truncated,
          ...(plan.truncated
            ? {
                totalLines: clamped.endLine - clamped.startLine + 1,
                ...(plan.next ? { next: plan.next } : {}),
              }
            : {}),
          stale,
          workingTreeSha: head,
        }),
      );
    }

    if (blocks.length === 0) {
      return {
        content:
          "Matching symbols were found, but their files could not be read from this project's " +
          "repository working tree (or did not fit the budget). Use search_code_symbols for locators.",
        resultCount: 0,
      };
    }
    // Notes BEFORE the spans: the model cap keeps a result's start (#2325).
    const notes: string[] = [formatCodeVersionLine(citations), ...staleNotes];
    if (notReturned > 0) {
      notes.push(
        `${notReturned} more span${notReturned === 1 ? "" : "s"} not returned (span limit); ask ` +
          `again with a narrower question, or read one with read_file_slice.`,
      );
    }
    if (overBudget > 0) {
      // A count, never a `path:a-b`: the citation verifier would read a locator
      // here as lines this result returned.
      notes.push(
        `${overBudget} span${overBudget === 1 ? "" : "s"} left out for the token budget; ask ` +
          `again with a smaller limit or a narrower question, or find ` +
          `${overBudget === 1 ? "it" : "them"} with search_code_symbols.`,
      );
    }
    if (unreadable > 0) {
      notes.push(`${unreadable} matching span${unreadable === 1 ? "" : "s"} could not be read.`);
    }
    return {
      content: `${notes.filter(Boolean).join("\n")}\n\n${blocks.join("\n\n")}`,
      resultCount: blocks.length,
      truncated: notReturned > 0 || overBudget > 0 || citations.some((c) => c.truncated),
      citations,
    };
  }

  return {
    name: SEARCH_CODE_CONTEXT_TOOL,
    description:
      "Answer-oriented code search: a good FIRST call for a question about how the code works. " +
      `Returns ${DEFAULT_SPANS} whole functions/classes by default, up to ${MAX_SPANS} with limit ` +
      "(adjacent matches in one file merged into one span, " +
      "numbered lines, each with a path:start-end locator), ranked as search_code_symbols ranks them. " +
      "A long symbol comes back as its signature plus the matched part, with the range to read next. " +
      "Keep using search_code_graph, search_code_symbols and read_file_slice for anything it leaves out.",
    parameters,
    execute,
  };
}

/**
 * The span's plan and rendered block, cut down until it fits `remaining`
 * tokens: whole (or signature + matched window) when that fits, else fewer
 * lines, signature first, with the next range named. `null` when not even
 * the signature and one line fit.
 */
export function fitSpan(
  span: {
    startLine: number;
    endLine: number;
    hits: ReadonlyArray<{ startLine: number; endLine: number }>;
  },
  maxSpanLines: number,
  remaining: number,
  render: (plan: Plan) => string,
): { plan: Plan; block: string; cost: number } | null {
  let maxLines = maxSpanLines;
  for (;;) {
    const plan = planSpanLines(span, maxLines);
    const block = render(plan);
    const cost = Math.ceil(block.length / CHARS_PER_TOKEN);
    if (cost <= remaining) return { plan, block, cost };
    const shown = plan.ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
    if (shown <= MIN_FITTED_LINES) return null;
    // Scale the lines to the share of the cost that fits; always drop at least one.
    const scaled = Math.floor((shown * remaining) / cost);
    maxLines = Math.max(MIN_FITTED_LINES, Math.min(shown - 1, scaled));
  }
}

/** One span as the model reads it: a head with its locators, then numbered lines. */
function renderSpan(
  index: number,
  filePath: string,
  span: { startLine: number; endLine: number },
  plan: Plan,
  lines: readonly string[],
  merged: MergedSpan<Hit>,
): string {
  const locators = plan.ranges.map(([a, b]) => `${filePath}:${a}-${b}`).join(", ");
  const cut = plan.truncated
    ? ` (cut: ${span.endLine - span.startLine + 1} lines in all, from line ${span.startLine} to ` +
      `${span.endLine}${plan.next ? `; read lines ${plan.next.startLine}-${plan.next.endLine} next` : ""})`
    : "";
  const body: string[] = [];
  plan.ranges.forEach(([a, b], i) => {
    if (i > 0) body.push("…");
    for (let n = a; n <= b; n += 1) body.push(`${n}| ${lines[n - 1] ?? ""}`);
  });
  return `[${index}] ${locators} — ${spanLabel(merged.hits)}${cut}\n${body.join("\n")}`;
}
