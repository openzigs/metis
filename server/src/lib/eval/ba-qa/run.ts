/**
 * #2237 — the runner's testable half: the arms, the chat scope a question gets,
 * and the cited spans the judge is shown.
 */
import type { Citation, CitableProduct } from "./citations.js";
import { isMultiTurn, sourceKey, type BaQaQuestion } from "./fixture.js";
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
  const found = new Set(names.map((n) => sourceKey(product.name, product.documents.get(n) ?? n)));
  return expected.filter((key) => found.has(key));
}

/** The flags #2228 names as off by default; the `on` arm turns all three on. */
export const ARM_FLAGS = [
  "CHAT_CODE_SEARCH_TOOLS",
  "CHAT_FUSED_CODE_RETRIEVAL",
  "RAG_RERANK",
] as const;

export const ARMS = {
  /** Today's chat: every flag unset, so each reads its default (off). */
  off: {},
  on: { CHAT_CODE_SEARCH_TOOLS: "1", CHAT_FUSED_CODE_RETRIEVAL: "1", RAG_RERANK: "1" },
} as const satisfies Record<string, Partial<Record<(typeof ARM_FLAGS)[number], string>>>;
export type BaQaArm = keyof typeof ARMS;

export function parseArm(raw: string): BaQaArm {
  if (raw !== "off" && raw !== "on") throw new Error(`--arm takes off or on, not ${raw}`);
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
 * The in-process embedder's runtime for an arm. The `on` arm's cross-encoder
 * reranker cannot share the process with a worker-thread embedder (#222), so it
 * runs both inline; `off` keeps the default worker, as a deployment does.
 */
export function embedRuntimeFor(arm: string | null): "inline" | "worker" {
  return arm === "on" ? "inline" : "worker";
}

/**
 * Set the arm's flags on `env`, and unset the rest: an `off` run inherits no
 * flag from the caller's shell. Returns the flags as the arm ran them.
 */
export function applyArmEnv(env: NodeJS.ProcessEnv, arm: BaQaArm): Record<string, string> {
  const flags: Partial<Record<string, string>> = ARMS[arm];
  const applied: Record<string, string> = {};
  for (const key of ARM_FLAGS) {
    const value = flags[key];
    if (value === undefined) {
      delete env[key];
      applied[key] = "(unset: off)";
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
 * The spans the judge reads: one per citation with lines whose text can be
 * read. `read(product, path)` returns the file's text, or null. Returns the
 * spans and, per citation index, the span number it was given — or 0 for a
 * citation whose lines do not exist in the file: a range that is not there
 * supports nothing, and is not let off with the file-level check.
 */
export async function buildJudgedSpans(
  citations: readonly Citation[],
  read: (product: string, path: string) => Promise<string | null>,
): Promise<{ spans: JudgedSpan[]; index: Map<number, number> }> {
  const spans: JudgedSpan[] = [];
  const index = new Map<number, number>();
  for (const [i, c] of citations.entries()) {
    if (!c.lines) continue;
    const text = await read(c.products[0], c.path);
    const span = text === null ? null : sliceLines(text, c.lines);
    if (span === null) {
      index.set(i, 0);
      continue;
    }
    const n = spans.length + 1;
    spans.push({ n, label: `${c.products[0]}:${c.path}:${c.lines[0]}-${c.lines[1]}`, text: span });
    index.set(i, n);
  }
  return { spans, index };
}
