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
 * this process, and it must vanish with it. Nothing here is persisted and no
 * model input changes.
 *
 * PER-POD CAVEAT. With more than one server replica (the Helm chart's
 * `replicaCount: 2`) and no session affinity, successive polls of the snapshot
 * land on different pods, and only the pod running the agent has its entry.
 * The analysis page therefore keeps an agent it has seen live showing as
 * running across polls that lack the entry, until the agent's stored result
 * changes, the run stops `running`, or `LIVE_AGENT_STICKY_MS` passes without a
 * sighting (`stickyLiveAgents`, `ui/src/components/analysis/analysis-views.ts`).
 * The step count shown is then the last one a poll returned, not a live one —
 * and so are #2570's `filesRead` / `searches` counts: those of the last poll
 * that reached the working pod.
 * A page whose polls never reach the pod doing the work shows no live entry —
 * the pre-#766 behaviour, never a wrong one. See `deploy/helm/metis/README.md`.
 */
import type { AnalysisLiveAgent, CodePassMode } from "@metis/shared";
import { repoRelative } from "./tools/read-file-slice.js";

type Entry = AnalysisLiveAgent;

const registry = new Map<string, Map<string, Entry>>();

/**
 * #2570 — the files each entry has read, so `filesRead` counts distinct files.
 * Kept beside the entry, never in it: the entry is what the snapshot serves,
 * and a path in it could name a restricted file to a reader who cannot see it.
 */
const filesReadBy = new WeakMap<Entry, Set<string>>();

/** #2570 — the tools whose executed calls count as code searches. */
export const LIVE_SEARCH_TOOLS: ReadonlySet<string> = new Set([
  "grep_files",
  "search_code_graph",
  "search_code_symbols",
]);

/** #2570 — the tool whose successful calls count as files read. */
export const LIVE_READ_TOOL = "read_file_slice";

/** What {@link recordLiveToolCall} needs to classify one executed call. Never stored. */
export interface LiveToolCall {
  tool: string;
  args: unknown;
  /** The tool's own outcome: an errored read (missing, refused, restricted) read nothing. */
  isError?: boolean;
  /** The repository the pass reads (its connector id), so one path in two repositories is two files. */
  repo?: string;
}

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
    filesRead: 0,
    searches: 0,
    rerun: opts.rerun,
    phase: "investigating",
  });
  return true;
}

/**
 * Count one executed tool call. With the call (#2570), also classify it by tool
 * name: a code search, or a file read (counted once per distinct file). A call
 * that errored counts as a step but neither a search nor a read. Only counts
 * reach the entry. A no-op for an agent that is not tracked.
 */
export function recordLiveToolCall(
  analysisId: string,
  agentKey: string,
  call?: LiveToolCall,
): void {
  const entry = registry.get(analysisId)?.get(agentKey);
  if (!entry) return;
  entry.toolCalls++;
  if (!call) return;
  // A call that errored (an unknown tool, bad arguments, a refused or missing
  // file) searched or read nothing.
  if (call.isError === true) return;
  if (LIVE_SEARCH_TOOLS.has(call.tool)) {
    entry.searches++;
    return;
  }
  if (call.tool !== LIVE_READ_TOOL) return;
  const file = readFilePath(call.args);
  if (file === null) return;
  let files = filesReadBy.get(entry);
  if (!files) {
    files = new Set();
    filesReadBy.set(entry, files);
  }
  files.add(`${call.repo ?? ""}\u0000${file}`);
  entry.filesRead = files.size;
}

/**
 * The file a `read_file_slice` call names, normalised by the tool's own
 * `repoRelative`, so `./a.ts`, `/a.ts`, `src//a.ts` and `src/x/../a.ts` count as
 * the one file the tool reads.
 */
function readFilePath(args: unknown): string | null {
  const raw =
    args && typeof args === "object" ? (args as Record<string, unknown>).filePath : undefined;
  if (typeof raw !== "string") return null;
  const file = repoRelative(raw.trim());
  return file === "" || file === "." ? null : file;
}

/**
 * #2570 — the mode the agent's code pass runs in. A multi-repository pass
 * shares one entry, so it reads `explore` only while every pass explored, as
 * the run's capability record does (#2565). A no-op for an agent that is not
 * tracked.
 */
export function setLiveAgentMode(analysisId: string, agentKey: string, mode: CodePassMode): void {
  const entry = registry.get(analysisId)?.get(agentKey);
  if (!entry) return;
  if (entry.mode === undefined || (entry.mode === "explore" && mode === "fast")) entry.mode = mode;
}

/**
 * #1131 — a "Continue with a larger budget" rerun knows its scope: it
 * re-investigates `requirements` of the run's `total`. A no-op for an agent
 * that is not tracked.
 */
export function setLiveAgentContinuation(
  analysisId: string,
  agentKey: string,
  scope: { requirements: number; total: number },
): void {
  const entry = registry.get(analysisId)?.get(agentKey);
  if (entry) entry.continuation = { ...scope };
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
  return agents
    ? [...agents.values()].map((entry) => ({
        ...entry,
        ...(entry.continuation ? { continuation: { ...entry.continuation } } : {}),
      }))
    : [];
}

/** Test seam: forget everything. */
export function resetLiveAgentsForTests(): void {
  registry.clear();
}
