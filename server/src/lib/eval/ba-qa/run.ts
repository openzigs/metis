/**
 * #2237 — the runner's testable half: the arms, the chat scope a question gets,
 * and the cited spans the judge is shown.
 */
import type { Citation } from "./citations.js";
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
