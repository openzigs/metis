/**
 * Deterministic grounding helpers for the Spec Kit commands (#20).
 *
 * The prompts ask `/plan` to name the existing files it changes and `/tasks` to
 * order tests first, but an LLM can ignore a prompt rule silently. These helpers
 * make each outcome observable after generation:
 *
 *   - `extractRequirementText` builds the retrieval query from the spec's own
 *     requirement text (summary, in-scope items, acceptance criteria) rather than
 *     the project name or generic architecture vocabulary, which drowned the ask.
 *   - `verifyPlanPaths` checks every backticked path in `plan.md` against the
 *     project's code graph, so an invented file is reported instead of trusted.
 *   - `findTestsAfterImplementation` flags test tasks that trail the
 *     implementation task covering the same acceptance criterion.
 *   - `describeGrounding` reports code symbols alongside document chunks, which
 *     "grounded on N chunks" used to omit.
 *   - `findFalseNotRetrievedClaims` (#1060) checks every "not in the retrieved
 *     context" a plan writes against the files the plan was actually given, and
 *     `renderPlanContext` records that list beside the plan.
 *
 * Every lookup is project-scoped and parameterised through Prisma; paths taken
 * from model output are only ever compared, never used to touch the filesystem.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { parseContractTasks } from "./artifact-contract.js";

const log = createChildLogger("spec-kit-grounding");

/**
 * Requirements documents pinned whole into `/specify` and `/plan` context. Two
 * documents of up to eight chunks each bound the added context while covering
 * a requirements document of a few kilobytes end to end.
 */
export const PINNED_REQUIREMENT_DOCUMENTS = { maxDocuments: 2, maxChunksPerDocument: 8 } as const;

/** `spec.md` sections that describe people or exclusions, not the change itself. */
const NON_REQUIREMENT_SECTIONS = new Set([
  "stakeholders",
  "out of scope",
  "non-functional requirements",
]);

/**
 * The requirement text of a `spec.md`: its summary, in-scope items and
 * acceptance criteria, with headings and emphasis stripped. Falls back to the
 * trimmed input when the filter leaves nothing (a spec that ignores the
 * section contract still retrieves on something).
 */
export function extractRequirementText(spec: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of spec.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const title = heading[1]!
        .replace(/#+\s*$/, "")
        .trim()
        .toLowerCase();
      skipping = NON_REQUIREMENT_SECTIONS.has(title);
      continue;
    }
    if (skipping) continue;
    const text = line.replace(/\*\*|__/g, "").trim();
    if (text.length > 0) kept.push(text);
  }
  return kept.length > 0 ? kept.join("\n") : spec.trim();
}

/** Upper bound on paths checked per plan, so a runaway output stays one query. */
const MAX_CHECKED_PATHS = 50;

/** Longer backticked spans are code, not a path. */
const MAX_PATH_LENGTH = 300;

/**
 * A repo-relative path: two or more segments, the last carrying an extension.
 * Segment characters admit Next.js route groups (`(authed)`) and dynamic
 * segments (`[id]`).
 */
const PATH_RE = /^(?:[\w.@()[\]$+-]+\/)+[\w@()[\]$+-][\w.@()[\]$+-]*\.[A-Za-z0-9]+$/;

/**
 * Backticked file paths referenced in a Markdown document, in first-seen order,
 * with `:line`, `:start-end` and `::symbol` suffixes and a leading `./` removed.
 */
export function extractReferencedPaths(markdown: string): string[] {
  const seen = new Set<string>();
  for (const m of markdown.matchAll(/`([^`\n]+)`/g)) {
    const candidate = m[1]!
      .trim()
      .replace(/::.*$/, "")
      .replace(/:\d+(?:-\d+)?$/, "")
      .replace(/^\.\//, "");
    // The length cap keeps PATH_RE's backtracking bounded on hostile output.
    if (candidate.length > MAX_PATH_LENGTH || candidate.includes("://")) continue;
    if (!PATH_RE.test(candidate)) continue;
    seen.add(candidate);
    if (seen.size >= MAX_CHECKED_PATHS) break;
  }
  return [...seen];
}

/** Project-scoped view of the code graph's file paths. Injectable for tests. */
export interface PlanPathLookup {
  /** Whether the project has any indexed code symbol at all. */
  hasCodeGraph(projectId: string): Promise<boolean>;
  /** Stored file paths that may match `paths` (a superset is fine). */
  findExisting(projectId: string, paths: string[]): Promise<string[]>;
}

export function createDefaultPlanPathLookup(): PlanPathLookup {
  return {
    async hasCodeGraph(projectId) {
      const row = await prisma.codeSymbol.findFirst({
        where: { projectId },
        select: { id: true },
      });
      return row !== null;
    },
    async findExisting(projectId, paths) {
      // Candidate rows share the basename; the exact suffix test runs in memory
      // because a stored path may be longer or shorter than the plan's form.
      const basenames = [...new Set(paths.map((p) => p.slice(p.lastIndexOf("/") + 1)))];
      const rows = await prisma.codeSymbol.findMany({
        where: { projectId, OR: basenames.map((b) => ({ filePath: { endsWith: b } })) },
        select: { filePath: true },
        distinct: ["filePath"],
      });
      return rows.map((r) => r.filePath);
    },
  };
}

export interface PlanPathCheck {
  /** False when the check could not run (no paths, no code graph, lookup failed). */
  checked: boolean;
  referenced: string[];
  /** Referenced paths that match no file in the project's code graph. */
  unverified: string[];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function samePath(referenced: string, stored: string): boolean {
  const s = normalizePath(stored);
  return s === referenced || s.endsWith(`/${referenced}`) || referenced.endsWith(`/${s}`);
}

/**
 * Check every backticked path in a plan against the project's code graph.
 * Never throws: a failed lookup reports `checked: false` rather than failing
 * the command that already produced the plan.
 */
export async function verifyPlanPaths(
  projectId: string,
  markdown: string,
  lookup: PlanPathLookup = createDefaultPlanPathLookup(),
): Promise<PlanPathCheck> {
  const referenced = extractReferencedPaths(markdown);
  const unchecked: PlanPathCheck = { checked: false, referenced, unverified: [] };
  try {
    if (!(await lookup.hasCodeGraph(projectId))) return unchecked;
    // A plan that names no path at all is still checked against a code graph:
    // naming no existing file is the #20 failure itself (PR #419 review).
    if (referenced.length === 0) return { checked: true, referenced, unverified: [] };
    const stored = await lookup.findExisting(projectId, referenced);
    const unverified = referenced.filter((p) => !stored.some((s) => samePath(p, s)));
    return { checked: true, referenced, unverified };
  } catch (err) {
    log.debug("plan path check failed, skipping", {
      projectId,
      error: (err as Error).message,
    });
    return unchecked;
  }
}

/** The phrase the plan prompt reserves for a file it was not given. */
const NOT_RETRIEVED_PHRASE = "not in the retrieved context";

/** Lines longer than this are not prose a claim sits in; they are skipped. */
const MAX_CLAIM_LINE_CHARS = 2000;

/**
 * Words that may stand between a path and the phrase without changing what the
 * phrase is about: `` `a.go` is `` / `` `a.go`, which is also ``. Anything else
 * (`` `a.go` is needed, and the batch helper is ``) makes the sentence about
 * something other than the path.
 */
const CLAIM_LINK_WORDS: ReadonlySet<string> = new Set([
  "is",
  "are",
  "was",
  "were",
  "also",
  "both",
  "each",
  "still",
  "itself",
  "which",
  "that",
  "likewise",
]);
/** Backticked spans looked at, nearest first, to find what one phrase is about. */
const MAX_SUBJECT_LOOKBACK = 4;

/** The lowercase words of `gap`, with parentheticals, punctuation and emphasis removed. */
function gapWords(gap: string): string[] {
  let depth = 0;
  let kept = "";
  for (const ch of gap) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) kept += ch;
  }
  return kept
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function onlyWords(gap: string, allowed: ReadonlySet<string>, max: number): boolean {
  const words = gapWords(gap);
  return words.length <= max && words.every((w) => allowed.has(w));
}

/** `` `x` — not in … `` after the phrase: only a colon or a dash may introduce the path. */
function isIntroducer(gap: string): boolean {
  const bare = gap.replace(/[\s*_]/g, "");
  return bare === ":" || bare === "—" || bare === "–" || bare === "-";
}

interface ClaimSpan {
  start: number;
  end: number;
  text: string;
}

/**
 * The backticked spans one occurrence of the phrase is ABOUT, within its own
 * clause (`from`…`to`, the phrase at `at`…`after`):
 *
 *   - the nearest span before the phrase, when only linking words stand between
 *     them, and the spans listed with it (`` `a.go`, `b.go` and `c.go` are not … ``);
 *   - otherwise the first span after the phrase, when a colon or a dash
 *     introduces it (`` not in the retrieved context: `a.go`, `b.go` ``), and the
 *     spans listed with it.
 */
function claimSubjects(
  masked: string,
  spans: readonly ClaimSpan[],
  from: number,
  at: number,
  after: number,
  to: number,
): ClaimSpan[] {
  const before = spans.filter((s) => s.start >= from && s.end <= at);
  // Only the few spans nearest the phrase: each look reads the text up to the
  // phrase, so an unbounded walk back over nested asides would be quadratic.
  const stop = Math.max(0, before.length - MAX_SUBJECT_LOOKBACK);
  for (let i = before.length - 1; i >= stop; i--) {
    const span = before[i]!;
    const gap = masked.slice(span.end, at);
    if (closesParenthesis(gap)) {
      // The span sits inside a parenthetical. `(unlike `b.go`)` is an aside
      // about something else: skip it, and what stands before the parenthesis
      // is looked at next. `the storage layer (`a.go`)` names the subject.
      if (!isApposition(masked, span)) continue;
    }
    if (!onlyWords(gap, CLAIM_LINK_WORDS, 4)) break;
    const subjects = [span];
    for (let j = i - 1; j >= 0; j--) {
      const between = masked.slice(before[j]!.end, before[j + 1]!.start);
      // `` `a.go` (`Fn`) ``: the path the parenthesised symbol belongs to.
      const owner = j === i - 1 && between.trim() === "(" && isApposition(masked, span);
      if (!owner && !isListGap(between)) break;
      subjects.push(before[j]!);
    }
    return subjects;
  }
  const following = spans.filter((s) => s.start >= after && s.end <= to);
  const first = following[0];
  if (!first || !isIntroducer(masked.slice(after, first.start))) return [];
  const subjects = [first];
  for (let i = 1; i < following.length; i++) {
    if (!isListGap(masked.slice(following[i - 1]!.end, following[i]!.start))) break;
    subjects.push(following[i]!);
  }
  return subjects;
}

/** `gap` closes a parenthesis it did not open: what precedes it is inside one. */
function closesParenthesis(gap: string): boolean {
  let depth = 0;
  for (const ch of gap) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return true;
      depth--;
    }
  }
  return false;
}

/** The span is the whole content of a parenthesis: `` (`a.go`) ``. */
function isApposition(masked: string, span: ClaimSpan): boolean {
  let open = span.start - 1;
  while (open >= 0 && (masked[open] === " " || masked[open] === "\t")) open--;
  let close = span.end;
  while (close < masked.length && (masked[close] === " " || masked[close] === "\t")) close++;
  return masked[open] === "(" && masked[close] === ")";
}

/**
 * Between two paths of one list: commas, `and` / `or` / `nor`, `&`, `/`, or
 * nothing. Any other character ends the list: a dash, a colon, a parenthesis.
 * Two character classes around one optional word, anchored: linear.
 */
function isListGap(gap: string): boolean {
  return /^[\s,&/]*(?:(?:and|or|nor)[\s,]*)?$/i.test(gap);
}

/** A clause ends at a table cell's `|`, a `;`, or a sentence end. */
function isClauseBoundary(masked: string, i: number): boolean {
  const ch = masked[i];
  if (ch === "|" || ch === ";") return true;
  if (ch !== "." && ch !== "!" && ch !== "?") return false;
  const next = masked[i + 1];
  return next === undefined || next === " " || next === "\t";
}

/**
 * #1060 — the files a plan puts "not in the retrieved context" next to although
 * its context named them. In #706 run 7 that sentence could not be checked:
 * nothing recorded what the plan had been given.
 *
 * Built to be PRECISE, because the result is shown to the user as a finding
 * (#1094 review M3: the first version compared every backticked span on the
 * line and accused correct plans). A path is reported only when
 *
 *   1. it is what the phrase is about — the nearest backticked span before the
 *      phrase in the same clause or table cell, with nothing but a linking word
 *      between them, or one a colon or dash introduces right after the phrase
 *      ({@link claimSubjects}); a list (`` `a.go`, `b.go` and `c.go` ``) counts whole;
 *   2. and it is EXACTLY a file in `files`, after stripping `./`, a `:line` span
 *      and a `::symbol` suffix. A directory (`internal/storage`) and a bare file
 *      name (`model.go`) match nothing: several listed files can sit under one
 *      or share the other, and the plan may mean a different one.
 *
 * So it under-reports, by design. NOT caught: a directory or a bare file name
 * (two of the three run-7 sentences were of that kind — `plan-context.md` is
 * how a reader checks those); a path on another line than the phrase, or in
 * another table cell; a path that is not backticked; a reworded phrase (`was
 * not retrieved`); a phrase wrapped across two lines; a line over
 * {@link MAX_CLAIM_LINE_CHARS}. One false positive remains and cannot be closed
 * without reading English: a sentence that DENIES the claim (`it would be wrong
 * to say `a.go` is not in the retrieved context`). The note is therefore worded
 * as a check result that stays true there too
 * ({@link describeFalseNotRetrievedClaims}).
 *
 * Linear in the plan: one pass over its lines; within a line (at most
 * {@link MAX_CLAIM_LINE_CHARS} characters) one non-nested pattern and scans
 * bounded by the line.
 */
export function findFalseNotRetrievedClaims(markdown: string, files: readonly string[]): string[] {
  if (files.length === 0) return [];
  const exact = new Set(files.map(normalizePath));
  const found = new Set<string>();
  for (const line of markdown.split("\n")) {
    if (line.length > MAX_CLAIM_LINE_CHARS) continue;
    const lower = line.toLowerCase();
    if (!lower.includes(NOT_RETRIEVED_PHRASE)) continue;
    const spans: ClaimSpan[] = [];
    // Clause boundaries are looked for outside code spans: `a | b` is not two cells.
    let masked = "";
    let copied = 0;
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const start = m.index;
      const end = start + m[0].length;
      spans.push({ start, end, text: m[1]! });
      masked += line.slice(copied, start) + "x".repeat(end - start);
      copied = end;
    }
    if (spans.length === 0) continue;
    masked += line.slice(copied);

    let clauseFloor = 0;
    for (
      let at = lower.indexOf(NOT_RETRIEVED_PHRASE);
      at !== -1;
      at = lower.indexOf(NOT_RETRIEVED_PHRASE, at + NOT_RETRIEVED_PHRASE.length)
    ) {
      const after = at + NOT_RETRIEVED_PHRASE.length;
      let from = at;
      while (from > clauseFloor && !isClauseBoundary(masked, from - 1)) from--;
      let to = after;
      while (to < masked.length && !isClauseBoundary(masked, to)) to++;
      for (const subject of claimSubjects(masked, spans, from, at, after, to)) {
        const span = normalizePath(
          subject.text
            .trim()
            .replace(/::.*$/, "")
            .replace(/:\d+(?:-\d+)?$/, ""),
        );
        if (span.length === 0 || span.length > MAX_PATH_LENGTH) continue;
        if (exact.has(span)) found.add(span);
        if (found.size >= MAX_CHECKED_PATHS) return [...found];
      }
      // The next occurrence's clause cannot reach back over this one.
      clauseFloor = after;
    }
  }
  return [...found];
}

/**
 * The note a command's message carries for {@link findFalseNotRetrievedClaims}.
 * `""` when none. It states what was checked, in terms the reader can verify
 * (the file IS in the recorded list; the phrase IS next to it in the plan), and
 * not what the plan meant: a plan that quotes or denies the claim is flagged
 * too, and the sentence is still true of it.
 */
export function describeFalseNotRetrievedClaims(
  claims: readonly string[],
  recordedIn?: string,
): string {
  if (claims.length === 0) return "";
  const one = claims.length === 1;
  const where = recordedIn ? ` (see \`${recordedIn}\`)` : "";
  return ` Check before implementing: ${claims.map((c) => `\`${c}\``).join(", ")} ${one ? "is" : "are"} in the list of files this plan was given${where}, and the plan has "not in the retrieved context" next to ${one ? "it" : "each"}.`;
}

/**
 * The note a command's message carries for what the localisation left out (its
 * token budget, a list cap, or a time limit). `""` when nothing was. With
 * `recordedIn`, the note gives the count and points at the artifact that lists
 * them; without it (the project-level `/plan`, which has no such artifact) it
 * lists them itself.
 */
export function describeContextDropped(dropped: readonly string[], recordedIn?: string): string {
  if (dropped.length === 0) return "";
  if (recordedIn) {
    const n = dropped.length;
    return ` Left out of the plan's context (token budget, list cap or time limit): ${n} item${n === 1 ? "" : "s"}, listed in \`${recordedIn}\`.`;
  }
  return ` Left out of the plan's context (token budget, list cap or time limit): ${dropped.join("; ")}.`;
}

/** The feature artifact the plan's context is recorded in. */
export const PLAN_CONTEXT_ARTIFACT = "plan-context.md";

/**
 * Feature artifacts METIS keeps for its own reader and that are NOT part of the
 * Spec Kit set: never exported into a target repository's `specs/<slug>/`.
 */
export const METIS_INTERNAL_FEATURE_ARTIFACTS: ReadonlySet<string> = new Set([
  PLAN_CONTEXT_ARTIFACT,
]);

/**
 * #1060 — `plan-context.md`: the files `/speckit.plan` was given, and what was
 * left out for the budget. Kept OUT of plan.md on purpose: the change-plan
 * scoring (#1042) counts the files a plan names, and a list of everything
 * retrieved is not a list of files to change.
 *
 * It is a METIS record, not a Spec Kit artifact: the installer does not write
 * it into the target repository (`installer/skeleton.ts`).
 *
 * `planVersion` is the version of the `plan.md` it describes. The record is
 * written after that `plan.md` with no transaction, so the two can part; naming
 * the version makes a record left over from an earlier plan say so itself.
 */
export function renderPlanContext(
  rag: {
    usedChunks: number;
    usedSymbols: number;
    files: readonly string[];
    dropped: readonly string[];
  },
  opts: { planVersion?: number } = {},
): string {
  const plan =
    opts.planVersion === undefined ? "the current `plan.md`" : `\`plan.md\` v${opts.planVersion}`;
  const lines = [
    "# Plan context",
    "",
    `What \`/speckit.plan\` was given when it wrote ${plan}. This is the retrieved`,
    "context, NOT the list of files to change: the plan names those. A file listed here was in",
    "the planner's context; a file that is not listed was not retrieved.",
    ...(opts.planVersion === undefined
      ? []
      : [
          "If `plan.md` is at another version, this record was not rewritten with it and describes",
          "the version named above.",
        ]),
    "",
    `- Grounding: ${describeGrounding(rag)}`,
    `- Files named in the context: ${rag.files.length}`,
    "",
    "## Files in the retrieved context",
    "",
    ...(rag.files.length > 0 ? rag.files.map((f) => `- \`${f}\``) : ["None."]),
    "",
    "## Left out (token budget, list cap or time limit)",
    "",
    ...(rag.dropped.length > 0 ? rag.dropped.map((d) => `- ${d}`) : ["Nothing."]),
    "",
  ];
  return lines.join("\n");
}

const TEST_TASK_RE = /\b(?:tests?|testing)\b/i;

/**
 * Ids of test tasks that come after an implementation task covering one of the
 * same acceptance criteria, where that implementation task carries no tests of
 * its own. Tests written first, or bundled into the implementation task, pass.
 */
export function findTestsAfterImplementation(tasksMarkdown: string): string[] {
  const untestedAcs = new Set<string>();
  const late: string[] = [];
  parseContractTasks(tasksMarkdown).forEach((task, index) => {
    const isTest = TEST_TASK_RE.test(task.title);
    if (isTest) {
      if (task.acIds.some((ac) => untestedAcs.has(ac))) {
        late.push(/^\s*(T\d+)\b/.exec(task.title)?.[1] ?? `task ${index + 1}`);
      }
      return;
    }
    for (const ac of task.acIds) untestedAcs.add(ac);
  });
  return late;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Human-readable grounding summary for a command's result message. */
export function describeGrounding(rag: { usedChunks: number; usedSymbols: number }): string {
  const parts: string[] = [];
  if (rag.usedChunks > 0) parts.push(plural(rag.usedChunks, "retrieved chunk", "retrieved chunks"));
  if (rag.usedSymbols > 0) parts.push(plural(rag.usedSymbols, "code symbol", "code symbols"));
  return parts.length > 0
    ? `grounded on ${parts.join(" and ")}`
    : "ungrounded (no project knowledge retrieved)";
}
