/**
 * Epic #156 — Built-in run handlers + run-group selection watcher.
 *
 * Each handler is intentionally lightweight; the heavy lifting of analysis /
 * publishing pipelines stays in their existing modules. The async-platform
 * goal here is to *coordinate* — handlers consume payloads, drain steer
 * messages, and emit step events.
 */
import { selectGroupWinner } from "./best-of-n.js";
import { scoreText } from "./best-of-n.js";
import type { AsyncRunner, RunHandler } from "./runner.js";
import { prisma } from "../prisma.js";

/** Default chat handler — echoes the prompt + queued steer messages. */
const chatHandler: RunHandler = async (ctx) => {
  ctx.emitStep("started", "chat run started");
  await ctx.heartbeat();
  if (ctx.signal.aborted) throw new Error("ABORTED");
  const initial = String((ctx.payload.message as string | undefined) ?? "");
  const steers = await ctx.nextSteer();
  const synth = [initial, ...steers.map((s) => s.content)].filter(Boolean).join("\n\n");
  ctx.emitStep("completed", `synthesized ${synth.length} chars`);
  await maybeRunGroupSelection(ctx.runId);
  return { result: { synthesis: synth, steerCount: steers.length }, score: scoreText(synth) };
};

/**
 * Analysis handler — placeholder that simulates a multi-step run. Real
 * analysis orchestration is wired through the existing
 * `AnalysisOrchestrator`; this handler simply records that a run completed
 * so it surfaces in the dashboard widget. v1.2 will swap this out for a
 * direct hand-off into the orchestrator with the same `signal`/`heartbeat`
 * contract.
 */
const analysisHandler: RunHandler = async (ctx) => {
  ctx.emitStep("plan", "analysis plan generated");
  await ctx.heartbeat();
  if (ctx.signal.aborted) throw new Error("ABORTED");
  const steers = await ctx.nextSteer();
  ctx.emitStep("execute", `executing with ${steers.length} steers`);
  await ctx.heartbeat();
  if (ctx.signal.aborted) throw new Error("ABORTED");
  ctx.emitStep("synthesize", "synthesis complete");
  const synth = `analysis(${ctx.projectId}) ok; steers=${steers.length}`;
  await maybeRunGroupSelection(ctx.runId);
  return { result: { synthesis: synth }, score: scoreText(synth) };
};

const browseHandler: RunHandler = async (ctx) => {
  ctx.emitStep("fetch", "browse start");
  await ctx.heartbeat();
  if (ctx.signal.aborted) throw new Error("ABORTED");
  const url = String((ctx.payload.url as string | undefined) ?? "");
  await maybeRunGroupSelection(ctx.runId);
  return { result: { url }, score: scoreText(url) };
};

const customHandler: RunHandler = async (ctx) => {
  ctx.emitStep("custom", "custom run start");
  await ctx.heartbeat();
  if (ctx.signal.aborted) throw new Error("ABORTED");
  await maybeRunGroupSelection(ctx.runId);
  return {
    result: { ok: true, payload: ctx.payload },
    score: scoreText(JSON.stringify(ctx.payload)),
  };
};

async function maybeRunGroupSelection(runId: string): Promise<void> {
  const row = await prisma.backgroundRun.findUnique({
    where: { id: runId },
    select: { runGroupId: true },
  });
  if (!row?.runGroupId) return;
  // Run on the next microtask so the current-run completion update is
  // already committed when the watcher inspects the group.
  queueMicrotask(() => {
    selectGroupWinner(row.runGroupId!).catch(() => {
      // Selection errors are observability-only; the runs themselves persist.
    });
  });
}

export function registerBuiltinRunHandlers(runner: AsyncRunner): void {
  runner.registerHandler("chat", chatHandler);
  runner.registerHandler("analysis", analysisHandler);
  runner.registerHandler("browse", browseHandler);
  runner.registerHandler("custom", customHandler);
}
