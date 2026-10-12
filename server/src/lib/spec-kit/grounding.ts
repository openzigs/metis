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
 *   - `renderPlanContext` (#1060) records the files a plan was given beside the
 *     plan, so a reader can check a "not in the retrieved context" statement by
 *     looking. No code decides what such a sentence is about: a check that did
 *     was wrong in two review cycles of #1094 and was removed.
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
