/**
 * Issue #766 — what an agent is doing RIGHT NOW, for the analysis page.
 *
 * A Regenerate (or a "Continue with a larger budget") re-runs one agent on a
 * finished analysis for anything from 25 seconds to 23 minutes (#706 run 8),
 * while that agent's stored result still reads `completed` with its old
 * findings until the new one replaces it. The page therefore showed no sign of
 * the re-run beyond the run header reading `running`.
 *
 * This is a process-local registry the orchestrator writes and the analysis
 * snapshot reads: which agents are running, since when, how many tool calls the
 * code agent's investigation has made, and whether the re-run has moved on to
 * re-synthesis. It is deliberately in memory — it describes work happening in
 * this process, and it must vanish with it. On a deployment with more than one
 * server process a snapshot served by another process reads no entry, which
 * degrades to the run header alone (the pre-#766 behaviour), never to a wrong
 * state. Nothing here is persisted and no model input changes.
 */
import type { AnalysisLiveAgent } from "@metis/shared";

type Entry = AnalysisLiveAgent;

const registry = new Map<string, Map<string, Entry>>();

/**
 * Start tracking `agentKey` on `analysisId`. Returns `false` (and changes
 * nothing) when the agent is already tracked, so a nested caller — the code
 * agent's tool loop inside a Regenerate — neither resets the count nor ends an
 * entry it did not start.
 */
export function beginLiveAgent(
  analysisId: string,
  agentKey: string,
  opts: { rerun: boolean; now?: Date },
): boolean {
  let agents = registry.get(analysisId);
  if (!agents) {
    agents = new Map();
    registry.set(analysisId, agents);
  }
  if (agents.has(agentKey)) return false;
  agents.set(agentKey, {
    agentKey,
    startedAt: (opts.now ?? new Date()).toISOString(),
    toolCalls: 0,
    rerun: opts.rerun,
    phase: "investigating",
  });
  return true;
}

/** Count one executed tool call. A no-op for an agent that is not tracked. */
export function recordLiveToolCall(analysisId: string, agentKey: string): void {
  const entry = registry.get(analysisId)?.get(agentKey);
  if (entry) entry.toolCalls++;
}

/** The re-run's own agent is done; the run is re-synthesising its findings. */
export function markLiveAgentSynthesizing(analysisId: string, agentKey: string): void {
  const entry = registry.get(analysisId)?.get(agentKey);
  if (entry) entry.phase = "synthesizing";
}

/** Stop tracking. Always called from a `finally`, so a failure cannot leave an entry. */
export function endLiveAgent(analysisId: string, agentKey: string): void {
  const agents = registry.get(analysisId);
  if (!agents) return;
  agents.delete(agentKey);
  if (agents.size === 0) registry.delete(analysisId);
}

/** A copy of the agents running on `analysisId`; empty when none is. */
export function readLiveAgents(analysisId: string): AnalysisLiveAgent[] {
  const agents = registry.get(analysisId);
  return agents ? [...agents.values()].map((entry) => ({ ...entry })) : [];
}

/** Test seam: forget everything. */
export function resetLiveAgentsForTests(): void {
  registry.clear();
}
