/**
 * #2237 — the runner's testable half: the arms, the chat scope a question gets,
 * and the cited spans the judge is shown.
 */
import { normalizeFilePath } from "../localization/corpus.js";
import type { CitableProduct, Citation } from "./citations.js";
import type { JudgedSpan } from "./judge.js";

/** The flags #2228 names as off by default; the `on` arm turns all three on. */
export const ARM_FLAGS = [
  "CHAT_CODE_SEARCH_TOOLS",
  "CHAT_FUSED_CODE_RETRIEVAL",
  "RAG_RERANK",
] as const;
type ArmFlag = (typeof ARM_FLAGS)[number];

/**
 * #2243 — every arm names each flag's value outright except `default`, which
 * unsets all three so each reads the server's own default. `off` is therefore
 * "all three off" whatever the defaults are, and each `no-*` arm takes one flag
 * away from `on`, so a flag's gain is measured on its own. `tools-only` sets
 * only the code-search tools.
 */
export const ARMS = {
  /** The server's defaults: every flag unset. */
  default: {},
  off: { CHAT_CODE_SEARCH_TOOLS: "0", CHAT_FUSED_CODE_RETRIEVAL: "0", RAG_RERANK: "0" },
  on: { CHAT_CODE_SEARCH_TOOLS: "1", CHAT_FUSED_CODE_RETRIEVAL: "1", RAG_RERANK: "1" },
  "no-tools": { CHAT_CODE_SEARCH_TOOLS: "0", CHAT_FUSED_CODE_RETRIEVAL: "1", RAG_RERANK: "1" },
  "no-fused": { CHAT_CODE_SEARCH_TOOLS: "1", CHAT_FUSED_CODE_RETRIEVAL: "0", RAG_RERANK: "1" },
  "no-rerank": { CHAT_CODE_SEARCH_TOOLS: "1", CHAT_FUSED_CODE_RETRIEVAL: "1", RAG_RERANK: "0" },
  /** Fused retrieval's gain over the tools alone, with the reranker off as it ships. */
  "tools-only": { CHAT_CODE_SEARCH_TOOLS: "1", CHAT_FUSED_CODE_RETRIEVAL: "0", RAG_RERANK: "0" },
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
 */
export function budgetStop(input: {
  budgetUsd: number;
  spentUsd: number;
  unpricedCalls: number;
  /** What each question asked so far cost, its answer and its judge. */
  questionCosts: readonly number[];
}): string | null {
  const { budgetUsd, spentUsd } = input;
  if (input.unpricedCalls > 0) return "an unpriced call: the cap cannot be enforced";
  if (spentUsd >= budgetUsd) return `the $${budgetUsd} cap was reached`;
  const costliest = Math.max(0, ...input.questionCosts);
  if (spentUsd + costliest > budgetUsd) {
    return `the next question would pass the $${budgetUsd} cap at the costliest one so far ($${costliest.toFixed(4)})`;
  }
  return null;
}

/** The fields of a results file that decide whether it can sit beside this run. */
export interface ComparableRun {
  kind: string;
  arm: string;
  model: string;
  judgeModel?: string;
  fixture: { id: string; version: number };
}

/**
 * Refuse an `--include`d run that is not comparable with `current`: another
 * fixture, version, answer model or judge, or an arm already in the report
 * (`arms`), which would print two columns under one name.
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
