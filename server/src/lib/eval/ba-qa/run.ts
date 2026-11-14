/**
 * #2237 — the runner's testable half: the arms, the chat scope a question gets,
 * and the cited spans the judge is shown.
 */
import { fileKey, normalizeFilePath } from "../localization/corpus.js";
import type { CitableProduct, Citation } from "./citations.js";
import { isMultiTurn, type BaQaQuestion } from "./fixture.js";
import type { JudgedSpan } from "./judge.js";

/**
 * #2269 — how a turn's auto-RAG reads the chat: `conversation` is production's
 * (#2240: the earlier turns shape the searches and cited excerpts carry
 * forward); `last-message` searches the new message alone, as chat did before.
 */
export const RETRIEVAL_MODES = ["conversation", "last-message"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

export function parseRetrievalMode(raw: string): RetrievalMode {
  if (raw !== "conversation" && raw !== "last-message") {
    throw new Error(`--retrieval takes conversation or last-message, not ${raw}`);
  }
  return raw;
}

/** The arm's column in the report: production's retrieval keeps the arm's own name. */
export function armLabel(arm: string, mode: RetrievalMode): string {
  return mode === "conversation" ? arm : `${arm}+${mode}`;
}

/**
 * The questions a run asks: the one-turn set of #2237 by default, the
 * multi-turn set with `multiTurn`, or the questions named in `ids` from either;
 * then at most `limit` of them.
 */
export function selectQuestions(
  all: readonly BaQaQuestion[],
  opts: { multiTurn?: boolean; ids?: readonly string[]; limit?: number },
): BaQaQuestion[] {
  let out = opts.ids
    ? all.filter((q) => opts.ids!.includes(q.id))
    : all.filter((q) => isMultiTurn(q) === Boolean(opts.multiTurn));
  if (opts.limit !== undefined) out = out.slice(0, opts.limit);
  return out;
}

/**
 * #2269 — the expected source files (`<product>:<path>`) that a turn's
 * retrieved excerpts include. `names` are the excerpts' names as the
 * retrieved-knowledge block lists them: a repository path, or an upload's
 * filename, which `product.documents` maps to the path a source names it by.
 */
export function retrievedExpectedFiles(
  expected: readonly string[],
  product: Pick<CitableProduct, "name" | "documents">,
  names: readonly string[],
): string[] {
  const found = new Set(names.map((n) => fileKey(product.name, product.documents.get(n) ?? n)));
  return expected.filter((key) => found.has(key));
}

/**
 * The flags #2228 names as off by default, and #2327's search primitives; the
 * `on` arm turns all of them on.
 */
export const ARM_FLAGS = [
  "CHAT_CODE_SEARCH_TOOLS",
  "CHAT_FUSED_CODE_RETRIEVAL",
  "RAG_RERANK",
  "CHAT_CODE_SEARCH_PRIMITIVES",
] as const;
type ArmFlag = (typeof ARM_FLAGS)[number];

/**
 * #2243 — every arm names each flag's value outright except `default`, which
 * unsets all three so each reads the server's own default. `off` is therefore
 * "all three off" whatever the defaults are, and each `no-*` arm takes one flag
 * away from `on`, so a flag's gain is measured on its own. `tools-only` sets
 * only the code-search tools.
 *
 * #2327 — `tools-primitives` is `tools-only` plus the search primitives
 * (`grep_files`, `list_files`, the symbol filters): paired with `tools-only`,
 * it measures what the primitives add.
 */
export const ARMS = {
  /** The server's defaults: every flag unset. */
  default: {},
  off: {
    CHAT_CODE_SEARCH_TOOLS: "0",
    CHAT_FUSED_CODE_RETRIEVAL: "0",
    RAG_RERANK: "0",
    CHAT_CODE_SEARCH_PRIMITIVES: "0",
  },
  on: {
    CHAT_CODE_SEARCH_TOOLS: "1",
    CHAT_FUSED_CODE_RETRIEVAL: "1",
    RAG_RERANK: "1",
    CHAT_CODE_SEARCH_PRIMITIVES: "1",
  },
  "no-tools": {
    CHAT_CODE_SEARCH_TOOLS: "0",
    CHAT_FUSED_CODE_RETRIEVAL: "1",
    RAG_RERANK: "1",
    CHAT_CODE_SEARCH_PRIMITIVES: "1",
  },
  "no-fused": {
    CHAT_CODE_SEARCH_TOOLS: "1",
    CHAT_FUSED_CODE_RETRIEVAL: "0",
    RAG_RERANK: "1",
    CHAT_CODE_SEARCH_PRIMITIVES: "1",
  },
  "no-rerank": {
    CHAT_CODE_SEARCH_TOOLS: "1",
    CHAT_FUSED_CODE_RETRIEVAL: "1",
    RAG_RERANK: "0",
    CHAT_CODE_SEARCH_PRIMITIVES: "1",
  },
  /** Fused retrieval's gain over the tools alone, with the reranker off as it ships. */
  "tools-only": {
    CHAT_CODE_SEARCH_TOOLS: "1",
    CHAT_FUSED_CODE_RETRIEVAL: "0",
    RAG_RERANK: "0",
    CHAT_CODE_SEARCH_PRIMITIVES: "0",
  },
  /** #2327 — the search primitives' gain over the tools alone. */
  "tools-primitives": {
    CHAT_CODE_SEARCH_TOOLS: "1",
    CHAT_FUSED_CODE_RETRIEVAL: "0",
    RAG_RERANK: "0",
    CHAT_CODE_SEARCH_PRIMITIVES: "1",
  },
} as const satisfies Record<string, Partial<Record<ArmFlag, string>>>;
export type BaQaArm = keyof typeof ARMS;

function isArm(raw: string): raw is BaQaArm {
  return Object.hasOwn(ARMS, raw);
}

export function parseArm(raw: string): BaQaArm {
  if (!isArm(raw)) throw new Error(`--arm takes ${Object.keys(ARMS).join(", ")}, not ${raw}`);
  return raw;
}

/**
 * The `--arm` value on a command line (`--arm on` or `--arm=on`), read before
 * `parseArgs` runs: the env module needs it before any import. Null when absent.
 */
export function armArgument(argv: readonly string[]): string | null {
  for (const [i, a] of argv.entries()) {
    if (a === "--arm") return argv[i + 1] ?? null;
    if (a.startsWith("--arm=")) return a.slice("--arm=".length);
  }
  return null;
}

/**
 * The in-process embedder's runtime for an arm. A cross-encoder reranker cannot
 * share the process with a worker-thread embedder (#222), so an arm that turns
 * `RAG_RERANK` on runs both inline; every other arm, and an unknown or absent
 * one, keeps the default worker, as a deployment does.
 */
export function embedRuntimeFor(arm: string | null): "inline" | "worker" {
  if (arm === null || !isArm(arm)) return "worker";
  const flags: Partial<Record<ArmFlag, string>> = ARMS[arm];
  return flags.RAG_RERANK === "1" ? "inline" : "worker";
}

/**
 * Set the arm's flags on `env`, and unset the rest: no arm inherits a flag
 * from the caller's shell or `.env`. Returns the flags as the arm ran them.
 */
export function applyArmEnv(env: NodeJS.ProcessEnv, arm: BaQaArm): Record<string, string> {
  const flags: Partial<Record<ArmFlag, string>> = ARMS[arm];
  const applied: Record<string, string> = {};
  for (const key of ARM_FLAGS) {
    const value = flags[key];
    if (value === undefined) {
      delete env[key];
      applied[key] = "(unset: default)";
    } else {
      env[key] = value;
      applied[key] = value;
    }
  }
  return applied;
}

/**
 * The project a chat session over `projectIds` binds to, as `POST /api/ai/sessions`
 * resolves it (`server/src/routes/ai.ts`, "Resolve the effective project scope"):
 * exactly one id binds that project; two or more degrade to an UNSCOPED session
 * ("multi-project-unsupported"), which gets no retrieval. Measuring today's
 * chat means asking a multi-product question the way chat would take it.
 */
export function chatSessionScope(projectIds: readonly string[]): {
  projectId: string | null;
  degraded: "multi-project-unsupported" | null;
} {
  if (projectIds.length === 1) return { projectId: projectIds[0], degraded: null };
  return {
    projectId: null,
    degraded: projectIds.length > 1 ? "multi-project-unsupported" : null,
  };
}

/** Lines `[a, b]` (1-based, inclusive) of `text`; null when the range is outside it. */
export function sliceLines(text: string, [a, b]: readonly [number, number]): string | null {
  const lines = text.split("\n");
  if (a > lines.length) return null;
  return lines.slice(a - 1, Math.min(b, lines.length)).join("\n");
}

/**
 * The spans the judge reads, for each citation with lines. `read(product,
 * path)` returns the file's text, or null. A citation of a path several
 * products hold (a README, a document uploaded to both) is read in EACH of
 * them: one span per distinct text, labelled with the products that share it,
 * so the judge never grades one product's lines as another's.
 *
 * Returns the spans and, per citation index, the span numbers it was given —
 * none for a citation whose lines exist in no file: a range that is not there
 * supports nothing, and is not let off with the file-level check.
 */
export async function buildJudgedSpans(
  citations: readonly Citation[],
  read: (product: string, path: string) => Promise<string | null>,
): Promise<{ spans: JudgedSpan[]; index: Map<number, number[]> }> {
  const spans: JudgedSpan[] = [];
  const index = new Map<number, number[]>();
  for (const [i, c] of citations.entries()) {
    if (!c.lines) continue;
    const byText = new Map<string, string[]>();
    for (const product of c.products) {
      const text = await read(product, c.path);
      const span = text === null ? null : sliceLines(text, c.lines);
      if (span !== null) byText.set(span, [...(byText.get(span) ?? []), product]);
    }
    const ns: number[] = [];
    for (const [text, products] of byText) {
      const n = spans.length + 1;
      spans.push({
        n,
        label: `${products.join(",")}:${c.path}:${c.lines[0]}-${c.lines[1]}`,
        text,
      });
      ns.push(n);
    }
    index.set(i, ns);
  }
  return { spans, index };
}

/**
 * Why the run stops before its next question, or null to go on. The cap is
 * checked between questions, so beyond the cap itself the run also stops when
 * the costliest question so far would carry the spend past it: a run with a
 * steady per-question cost then ends under the cap rather than one question
 * over it. The first question, or one costlier than any before it, can still
 * cross it, since nothing is known of its cost before it runs.
 *
 * #2316 — also checked within a question, before each of its steps (a turn
 * of a multi-turn question, then the judge), through {@link stepBudgetStop}
 * against the costliest step of the same kind: a question of four turns and a
 * judge no longer runs whole between two checks.
 */
export function budgetStop(input: {
  budgetUsd: number;
  spentUsd: number;
  unpricedCalls: number;
  /** What each question (or, for `step: "step"`, each step) so far cost. */
  questionCosts: readonly number[];
  /** What is about to run: a question (the default) or one step of one. */
  step?: "question" | StepKind;
}): string | null {
  const { budgetUsd, spentUsd } = input;
  if (input.unpricedCalls > 0) return "an unpriced call: the cap cannot be enforced";
  if (spentUsd >= budgetUsd) return `the $${budgetUsd} cap was reached`;
  const costliest = Math.max(0, ...input.questionCosts);
  if (spentUsd + costliest > budgetUsd) {
    return `the next ${input.step ?? "question"} would pass the $${budgetUsd} cap at the costliest one so far ($${costliest.toFixed(4)})`;
  }
  return null;
}

/** A step of a question: one turn of it, or the judge's grading of its answer. */
export type StepKind = "turn" | "judge";

/**
 * #2316 — what each kind of step cost so far, kept apart: a judge call costs a
 * fraction of an answer turn, so checking the judge against the costliest turn
 * would stop a run with the judge still fitting and leave a paid answer ungraded.
 */
export type StepCosts = Record<StepKind, number[]>;

/** {@link budgetStop} before one step of a question, against the costliest step of its kind. */
export function stepBudgetStop(input: {
  budgetUsd: number;
  spentUsd: number;
  unpricedCalls: number;
  stepCosts: StepCosts;
  next: StepKind;
}): string | null {
  return budgetStop({
    budgetUsd: input.budgetUsd,
    spentUsd: input.spentUsd,
    unpricedCalls: input.unpricedCalls,
    questionCosts: input.stepCosts[input.next],
    step: input.next,
  });
}

/**
 * The results-file format this code writes. 2 (#2265): a citation's check can
 * be `no-such-lines`, and the summary reports citation precision per check.
 */
export const BA_QA_RESULTS_VERSION = 2;

/** The fields of a results file that decide whether it can sit beside this run. */
export interface ComparableRun {
  kind: string;
  arm: string;
  model: string;
  judgeModel?: string;
  fixture: { id: string; version: number };
  /** The results-file format; a file written before #2265 carries none and is version 1. */
  version?: number;
}

/**
 * Refuse an `--include`d run that is not comparable with `current`: another
 * fixture, version, answer model or judge, an arm already in the report
 * (`arms`), which would print two columns under one name, or a version 1
 * results file (#2363): it labelled a citation to lines not in the file
 * `span`, so re-summarising it would count them under the wrong check.
 */
export function assertComparable(
  prior: ComparableRun,
  current: ComparableRun,
  arms: readonly string[],
  file: string,
): void {
  if (prior.kind !== current.kind || prior.fixture.id !== current.fixture.id) {
    throw new Error(`${file} is another eval or fixture: not comparable`);
  }
  // Only after the kind check: a top-level `version` means nothing outside
  // `kind: 'ba-qa'`, so another eval's file must not be refused for lacking one.
  const resultsVersion = prior.version ?? 1;
  if (resultsVersion < 2) {
    throw new Error(
      `${file} is results file version ${resultsVersion}, which labels lines not in the file ` +
        `as span-checked: re-run that arm rather than include it`,
    );
  }
  if (prior.fixture.version !== current.fixture.version) {
    throw new Error(
      `${file} scored fixture version ${prior.fixture.version}, not ${current.fixture.version}`,
    );
  }
  if (prior.model !== current.model) {
    throw new Error(`${file} answered with model ${prior.model}, not ${current.model}`);
  }
  if (prior.judgeModel !== current.judgeModel) {
    throw new Error(
      `${file} was judged by ${prior.judgeModel ?? "(unknown)"}, not ${current.judgeModel}`,
    );
  }
  if (arms.includes(prior.arm))
    throw new Error(`${file}: arm ${prior.arm} is already in the report`);
}

/**
 * The expected sources no product file or uploaded document answers to, as
 * `<question>: <product>:<path>`. A doc source named by its upload name rather
 * than the path a citation resolves to (`miniflux.1.txt` for `miniflux.1`), or
 * a typo, could never be cited: the question's recall would drop silently.
 */
export function unknownSources(
  questions: ReadonlyArray<{
    id: string;
    sources?: ReadonlyArray<{ product: string; path: string }>;
  }>,
  products: ReadonlyMap<string, CitableProduct>,
): string[] {
  const out: string[] = [];
  for (const q of questions) {
    for (const s of q.sources ?? []) {
      const p = products.get(s.product);
      const file = normalizeFilePath(s.path);
      const known =
        p !== undefined && (p.files.includes(file) || [...p.documents.values()].includes(file));
      if (!known) out.push(`${q.id}: ${s.product}:${s.path}`);
    }
  }
  return out;
}
