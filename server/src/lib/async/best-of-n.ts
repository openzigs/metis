/**
 * Epic #156 (#148) — Parallel best-of-N run group.
 *
 * `submitGroup` spawns N background runs sharing a `runGroupId` and registers
 * a watcher that runs the selection step once all children settle. Selection
 * methods:
 *   - `highest-score` — winner = run with the largest numeric `score`.
 *     Deterministic, used by tests.
 *   - `judge-llm` — uses the configured AI provider with a fixed system
 *     prompt. The `offline-stub` provider is deterministic in tests.
 *   - `manual` — leaves `winnerRunId` null; UI sets it via PATCH.
 */
import { prisma } from "../prisma.js";
import { getAsyncRunner, type RunKind } from "./runner.js";

export type SelectionMethod = "highest-score" | "judge-llm" | "manual";
export type GroupStrategy = "best-of-n" | "parallel";

export interface SubmitGroupInput {
  projectId: string;
  kind: RunKind | string;
  payload?: Record<string, unknown>;
  n: number;
  selectionMethod?: SelectionMethod;
  strategy?: GroupStrategy;
  parentRunId?: string | null;
}

export interface JudgeFn {
  (
    runs: Array<{ id: string; result: unknown; score: number | null }>,
  ): Promise<{ winnerRunId: string }>;
}

export interface SelectGroupOptions {
  judge?: JudgeFn;
}

export async function submitGroup(input: SubmitGroupInput): Promise<{
  groupId: string;
  runIds: string[];
}> {
  if (input.n < 1 || input.n > 8) throw new Error("n must be 1..8");
  const group = await prisma.runGroup.create({
    data: {
      projectId: input.projectId,
      parentRunId: input.parentRunId ?? null,
      n: input.n,
      strategy: input.strategy ?? "best-of-n",
      selectionMethod: input.selectionMethod ?? "highest-score",
      status: input.n === 1 ? "running" : "running",
    },
  });
  const runIds: string[] = [];
  const runner = getAsyncRunner();
  for (let i = 0; i < input.n; i++) {
    const r = await runner.submit({
      projectId: input.projectId,
      kind: input.kind,
      payload: { ...(input.payload ?? {}), variantIndex: i },
      runGroupId: group.id,
    });
    runIds.push(r.id);
  }
  return { groupId: group.id, runIds };
}

/**
 * Run the selection step. Idempotent: if winner already set, returns it.
 * Returns `null` when not all children have settled yet.
 */
export async function selectGroupWinner(
  groupId: string,
  opts: SelectGroupOptions = {},
): Promise<{ winnerRunId: string } | null> {
  const group = await prisma.runGroup.findUnique({
    where: { id: groupId },
    include: { runs: true },
  });
  if (!group) throw new Error("RUN_GROUP_NOT_FOUND");
  if (group.winnerRunId) return { winnerRunId: group.winnerRunId };

  const settled = group.runs.every(
    (r) => r.status === "succeeded" || r.status === "failed" || r.status === "cancelled",
  );
  if (!settled || group.runs.length < group.n) return null;

  const succeeded = group.runs.filter((r) => r.status === "succeeded");
  if (succeeded.length === 0) {
    await prisma.runGroup.update({
      where: { id: groupId },
      data: { status: "failed" },
    });
    return null;
  }

  let winnerRunId: string;
  if (group.selectionMethod === "highest-score") {
    const sorted = [...succeeded].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    winnerRunId = sorted[0]!.id;
  } else if (group.selectionMethod === "judge-llm") {
    const judge =
      opts.judge ??
      (async (rs) => {
        // Deterministic fallback: pick the run with the highest score; ties
        // broken by lexicographic id. Mirrors offline-stub determinism.
        const sorted = [...rs].sort(
          (a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || (a.id < b.id ? -1 : 1),
        );
        return { winnerRunId: sorted[0]!.id };
      });
    const { winnerRunId: w } = await judge(
      succeeded.map((r) => ({
        id: r.id,
        result: r.result ? safeParse(r.result) : null,
        score: r.score,
      })),
    );
    winnerRunId = w;
  } else {
    // manual — leave for the UI to PATCH the winner.
    return null;
  }

  await prisma.runGroup.update({
    where: { id: groupId },
    data: { winnerRunId, status: "completed" },
  });
  return { winnerRunId };
}

/**
 * Inline scoring helper for `highest-score`. Used by handlers that don't
 * compute a domain score themselves.
 */
export function scoreText(text: string): number {
  if (!text) return 0;
  const len = text.length;
  // Crude proxy: length + citation count.
  const citations = (text.match(/\[\d+\]|\(\d{4}\)/g) ?? []).length;
  return len + citations * 50;
}

/**
 * Epic #194 (C.3) — hallucination-aware judge.
 *
 * Wraps an existing JudgeFn so that grounding scores penalise the base
 * score before ranking. Used when best-of-N is configured for `judge-llm`
 * and a grounding scorer is wired in.
 */
export interface GroundingFn {
  (run: { id: string; result: unknown; score: number | null }): Promise<number>;
}

export function judgeWithHallucination(opts: {
  base?: JudgeFn;
  grounding: GroundingFn;
  /** Weight for grounding (default 0.5). Final score = base + weight * grounding. */
  weight?: number;
}): JudgeFn {
  const weight = opts.weight ?? 0.5;
  return async (runs) => {
    const grounded: { id: string; combined: number }[] = [];
    for (const r of runs) {
      const g = await opts.grounding(r).catch(() => 0);
      const combined = (r.score ?? 0) + weight * g;
      grounded.push({ id: r.id, combined });
    }
    grounded.sort((a, b) => b.combined - a.combined || (a.id < b.id ? -1 : 1));
    if (opts.base) {
      // Allow base judge to override when grounding is inconclusive (top
      // two are within 0.05 of each other).
      const top = grounded[0]!;
      const second = grounded[1];
      if (second && Math.abs(top.combined - second.combined) < 0.05) {
        return opts.base(runs);
      }
    }
    return { winnerRunId: grounded[0]!.id };
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
