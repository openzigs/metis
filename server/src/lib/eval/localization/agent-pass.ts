/**
 * #1755 — the analysis agent pass behind arm A3, over a MATERIALIZED corpus
 * (`pnpm eval:materialize`, #1799): each repository is an ingested project with
 * its symbol vectors and a clone, so the agent's tools read what they read in
 * production.
 *
 * The pass is set up the way "Evaluate new requirements" sets up the code
 * agent's agentic pass, with the orchestrator's own functions (as the #214
 * harness does): the requirements are `extractNewRequirementCandidates(text)`
 * (the `NR-*` candidates), the text is the run's `extraInstructions`, the seeded
 * blocks are `assembleAgenticPassSeeds`, the prompt is `buildAgenticPassPrompt`,
 * and the loop is `runAgentLoop` with the orchestrator's turn cap, token budget,
 * prompt caching and #769 final-answer retry. What it does NOT run: escalation
 * to a second pass, and the orchestrator's post-loop salvage. A pass with no
 * schema-valid answer still contributes the citations its last answer carried.
 *
 * The `files` tool set (arm A3N) gives the same loop only `list_files`,
 * `read_file_slice` and the eval-only `grep_files`, no seeded blocks, and the
 * prompt's investigation steps rewritten to name those tools; every other line
 * of the prompt is production's.
 *
 * #2560 — the `explorer` tool set (arm A20) asks whether a Claude-Code-style
 * agent localizes better: exploration first, with `grep_files`, `list_files`,
 * whole-file reads (up to {@link EXPLORER_READ_MAX_LINES} lines a call),
 * `search_code_graph` and `search_code_symbols` (its filters on). The seeded
 * blocks are still in the user message, but the steps call them hints to
 * check, not answers. The loop runs up to {@link EXPLORER_MAX_TURNS} turns
 * with NO token budget and a larger transcript ceiling
 * ({@link EXPLORER_TRANSCRIPT_TOKENS}); what bounds it is a dollar cap per
 * item (`costCapUsd`), checked before every model call. A pass stopped by the
 * cap has no answer, and scores as no citation.
 *
 * #2568 — the `production-explore` tool set (arm A21) is production's explore
 * mode as `runAgenticPass` runs it (#2565): {@link buildExploreCodePass}'s
 * tools, steps and transcript ceiling, production's turn cap and token budget,
 * #1388's continuation behind the explorer nudge, the final-answer retry with
 * its reasoning setting and evidence digest, and #2569's dollar ceiling on the
 * provider. There is no eval-only cap. `server/tests/eval-a21-parity-2568.sqlite.test.ts`
 * proves its loop matches the orchestrator's, so the eval cannot drift.
 */
import { promises as fs } from "node:fs";
import type { AIProvider } from "../../ai/types.js";
import {
  resolveAnalysisNativeTools,
  runAgentLoop,
  type AgentLoopResult,
} from "../../analysis/agent-loop.js";
import {
  FINAL_ANSWER_INSTRUCTION,
  isSchemaValidFinalAnswer,
} from "../../analysis/agentic-degradation.js";
import {
  buildEvidenceDigest,
  DEFAULT_RETRY_EVIDENCE_TOKENS,
  formatEvidenceForAnswer,
} from "../../analysis/agentic-evidence.js";
import {
  extractJsonObject,
  resolveFinalAnswerMaxOutputTokens,
} from "../../analysis/agent-runner.js";
import {
  agenticPassEffectiveBudget,
  buildAgenticPassPrompt,
  resolveAgentTokenBudget,
  resolveAgenticMaxTurns,
  resolveRecoveryReasoning,
  type AgenticPassSeeds,
} from "../../analysis/agentic-pass-context.js";
import { createCodePassCostCeiling } from "../../analysis/code-pass-cost-ceiling.js";
import { buildCodePassContinuation } from "../../analysis/code-pass-coverage.js";
import {
  buildExploreCodePass,
  countRepeatedToolCalls,
  EXPLORER_NUDGE,
  GRAPH_STEPS,
  explorerSystemMessage as productionExplorerSystemMessage,
  explorerTools as productionExplorerTools,
  type ExplorerSearchTools,
} from "../../analysis/code-pass-variant.js";
import { DEFAULT_TRANSCRIPT_COMPACTION } from "../../analysis/context-window-manager.js";
import { listFilesTool } from "../../analysis/tools/list-files.js";
import { readFileSliceTool } from "../../analysis/tools/read-file-slice.js";
import type { AgentTool, ToolContext } from "../../analysis/tools/types.js";
import {
  citationTargets,
  DEFAULT_SEED_CONFIDENCE,
} from "../../traceability/seed-code-links-from-findings.js";
import {
  EXPLORER_MAX_TURNS,
  EXPLORER_READ_MAX_LINES,
  EXPLORER_TRANSCRIPT_TOKENS,
  type AgentCitation,
  type AgentPass,
  type AgentPassLoop,
  type AgentPassRequest,
  type AgentPassResult,
} from "./arm-core.js";
import { grepFilesTool } from "../../analysis/tools/grep-files.js";
import type { MaterializedState } from "./materialize.js";

/** What the pass reads about a materialized project. */
export interface PassProject {
  name: string;
  description: string;
  databaseAware: boolean;
}

export interface MaterializedAgentPassDeps {
  /** The METERED provider. */
  provider: AIProvider;
  /** The materialized state of each corpus the run reads, by corpus name. */
  states: ReadonlyMap<string, MaterializedState>;
  loadProject: (projectId: string) => Promise<PassProject>;
  /** The orchestrator's `assembleAgenticPassSeeds`, bound to the run's database. */
  assembleSeeds: (input: {
    projectId: string;
    projectName: string;
    projectDescription: string;
    extraInstructions: string;
    requirements: Array<{ id: string; text: string }>;
    databaseAware: boolean;
  }) => Promise<AgenticPassSeeds>;
  /**
   * The orchestrator's `assembleAgenticCodeTools` for a verified clone
   * directory; with `primitives` (#2327, A3P), through {@link withSearchPrimitives}.
   */
  graphTools: (cloneDir: string | undefined, primitives: boolean) => AgentTool[];
  /** `extractNewRequirementCandidates`. */
  extractRequirements: (text: string) => Promise<Array<{ id: string; text: string }>>;
  /**
   * #2560 — the explorer's (A20) search tools for a verified clone: production's
   * `search_code_graph` and `search_code_symbols` with its filters on. The pass
   * adds the file tools ({@link explorerTools}). #2568 — A21 reads the same
   * two through {@link buildExploreCodePass}, as the orchestrator does.
   */
  explorerSearchTools?: () => { searchCodeGraph: AgentTool; searchCodeSymbols: AgentTool };
  /** #2560 — the run meter's dollars spent so far: what a pass's `costCapUsd` is read against. */
  spentUsd?: () => number;
  /** `runAgentLoop`; a seam for tests. */
  runLoop?: typeof runAgentLoop;
}

/**
 * #2560 — the explorer's tools, in the order the model is shown them. #2565 —
 * production's explore-mode tools ({@link productionExplorerTools}) at A20's
 * read cap, so the eval measures the pass production runs.
 */
export function explorerTools(search: ExplorerSearchTools): AgentTool[] {
  return productionExplorerTools(search, EXPLORER_READ_MAX_LINES);
}

/** Thrown by the explorer's model caller once the pass's dollar cap is spent. */
export class PassCostCapReached extends Error {
  constructor(readonly capUsd: number) {
    super(`the pass reached its $${capUsd.toFixed(2)} cap`);
    this.name = "PassCostCapReached";
  }
}

/** The seeds of a pass that starts from nothing (A3N). */
export const NO_SEEDS: AgenticPassSeeds = {
  fused: { block: "", tokens: 0 },
  affectedCode: { block: "", tokens: 0 },
  affectedSchema: { block: "", tokens: 0 },
};

/** The file tools A3N gets. */
export const FILE_ONLY_TOOLS: readonly AgentTool[] = [
  listFilesTool,
  readFileSliceTool,
  grepFilesTool,
];

/**
 * #2327 — A3P's tools: `tools` (production's graph set) with
 * `search_code_symbols` replaced by `filteredSymbols` (the same tool with its
 * filters on) and, with a working tree, `grep_files` added: chat's search
 * primitives on the analysis agent.
 */
export function withSearchPrimitives(
  tools: readonly AgentTool[],
  cloneDir: string | undefined,
  filteredSymbols: AgentTool,
): AgentTool[] {
  const out = tools.map((t) => (t.name === filteredSymbols.name ? filteredSymbols : t));
  if (cloneDir && !out.some((t) => t.name === grepFilesTool.name)) out.push(grepFilesTool);
  return out;
}

const FILE_STEPS = [
  "- Start by using grep_files to find where relevant names and phrases appear in the repository",
  "- Use read_file_slice to examine specific implementations",
  "- Use list_files to discover project structure when needed",
].join("\n");

/**
 * A3N's prompt: production's, with the investigation steps naming only the
 * file tools. Throws when production's steps are not found, so a prompt change
 * cannot leave A3N pointing the model at tools it was not given.
 */
export function filesOnlySystemMessage(systemMessage: string): string {
  if (!systemMessage.includes(GRAPH_STEPS)) {
    throw new Error(
      "A3N: the agentic code prompt's investigation steps changed; update FILE_STEPS in agent-pass.ts",
    );
  }
  return systemMessage.replace(GRAPH_STEPS, FILE_STEPS);
}

/**
 * #2560 — A20's prompt: production's, with the investigation steps rewritten
 * for exploration first. #2565 — production's explore-mode prompt
 * ({@link productionExplorerSystemMessage}) at A20's read cap: the steps and
 * {@link EXPLORER_NUDGE} are defined in production code only.
 */
export function explorerSystemMessage(systemMessage: string): string {
  return productionExplorerSystemMessage(systemMessage, EXPLORER_READ_MAX_LINES);
}

export { EXPLORER_NUDGE };

/**
 * The citations of an answer that could be code, in answer order, each with its
 * finding's confidence (clamped; {@link DEFAULT_SEED_CONFIDENCE} when absent),
 * read the way `seedRequirementCodeLinksFromFindings` reads a finding's evidence.
 */
export function citationsFromAnswer(text: string | undefined): AgentCitation[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = extractJsonObject(text);
  } catch {
    return [];
  }
  const findings = (parsed as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findings)) return [];
  const out: AgentCitation[] = [];
  for (const f of findings as Array<Record<string, unknown> | null>) {
    if (!f || typeof f !== "object") continue;
    const raw =
      typeof f.confidence === "number" && Number.isFinite(f.confidence)
        ? f.confidence
        : DEFAULT_SEED_CONFIDENCE;
    const confidence = Math.min(1, Math.max(0, raw));
    for (const target of citationTargets(f.citations)) out.push({ ...target, confidence });
  }
  return out;
}

/** The citations of a loop result: its answer's, else (no valid answer) its salvage source's. */
export function citationsOfLoop(
  result: Pick<AgentLoopResult, "finalResponse" | "salvageSource">,
): AgentCitation[] {
  const answer = citationsFromAnswer(result.finalResponse);
  return answer.length > 0 ? answer : citationsFromAnswer(result.salvageSource);
}

async function existingDir(dir: string): Promise<string | undefined> {
  const stat = await fs.stat(dir).catch(() => null);
  return stat?.isDirectory() ? dir : undefined;
}

/**
 * #1819 — the CLI's preflight for the arms whose file tools read only the clone
 * (A3N, and A20 since #2560): every materialized repository's clone is on disk.
 * The pass checks it too, but only at its first reading of such an arm, after
 * run 1's A3 and A3A passes are paid for; this check runs before any spend.
 */
export async function assertClonesFor(
  states: ReadonlyMap<string, Pick<MaterializedState, "repos">>,
  /** The arm (or arms, e.g. `A3N/A20`) the check is for, named in the error. */
  arm: string,
): Promise<void> {
  const missing: string[] = [];
  for (const [corpus, state] of states) {
    for (const repo of state.repos) {
      if ((await existingDir(repo.cloneDir)) === undefined) {
        missing.push(
          `${corpus}/${repo.name} (${repo.cloneDir}): run pnpm eval:materialize ${corpus}`,
        );
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${arm} needs every repository's clone, and these are not directories:\n  - ${missing.join("\n  - ")}`,
    );
  }
}

/** #2568 — what the report reads about how a pass's loop ended and what it spent. */
export function loopStats(result: AgentLoopResult, tokenBudget: number | null): AgentPassLoop {
  return {
    tokensUsed: result.usage.totalTokens,
    tokenBudget,
    promptTokens: result.usage.promptTokens,
    cacheReadTokens: result.usage.cacheReadTokens ?? 0,
    cacheWriteTokens: result.usage.cacheWriteTokens ?? 0,
    budgetExhausted: result.budgetExhausted,
    turnsExhausted: result.turnsExhausted,
    costCeilingReached: result.costCeilingReached === true,
    repeatedToolCalls: countRepeatedToolCalls(result.toolCalls),
  };
}

/** The pass over a materialized corpus. Throws on an unmaterialized corpus or repository. */
export function createMaterializedAgentPass(deps: MaterializedAgentPassDeps): AgentPass {
  const runLoop = deps.runLoop ?? runAgentLoop;
  const model = deps.provider.model;
  return async (request: AgentPassRequest): Promise<AgentPassResult> => {
    const state = deps.states.get(request.corpus);
    if (!state) {
      throw new Error(
        `${request.corpus} is not materialized: run pnpm eval:materialize ${request.corpus}`,
      );
    }
    const repo = state.repos.find((r) => r.name === request.repo);
    if (!repo) {
      throw new Error(`${request.corpus}: repository ${request.repo} is not materialized`);
    }
    const project = await deps.loadProject(repo.projectId);
    const cloneDir = await existingDir(repo.cloneDir);
    const explorer = request.toolset === "explorer";
    const productionExplore = request.toolset === "production-explore";
    const graph = request.toolset !== "files";
    // #1810 — the file tools read only the clone. Without it every A3N call
    // fails, and the pass would score about 0 at full cost; the graph pass runs
    // without a working tree, as production does. #2560 — A20 explores with the
    // file tools first, so it needs the clone too. #2568 — production runs a
    // pass with no working tree fast (`no-working-tree`), so A21 without the
    // clone would measure A3A under A21's label: refused instead.
    if ((!graph || explorer || productionExplore) && cloneDir === undefined) {
      const arm = explorer ? "A20" : productionExplore ? "A21" : "A3N";
      throw new Error(
        `${arm} needs the clone of ${request.corpus}/${request.repo}, and ${repo.cloneDir} is not a directory: run pnpm eval:materialize ${request.corpus}`,
      );
    }
    if (explorer && (!deps.explorerSearchTools || !deps.spentUsd)) {
      throw new Error(
        "A20 needs the explorer's search tools and the run meter (explorerSearchTools, spentUsd)",
      );
    }
    if (productionExplore && !deps.explorerSearchTools) {
      throw new Error("A21 needs the explore pass's search tools (explorerSearchTools)");
    }
    const extracted = await deps.extractRequirements(request.text);
    const requirements = extracted.length > 0 ? extracted : [{ id: "NR-1", text: request.text }];
    const seeds = graph
      ? await deps.assembleSeeds({
          projectId: repo.projectId,
          projectName: project.name,
          projectDescription: project.description,
          extraInstructions: request.text,
          requirements,
          databaseAware: project.databaseAware,
        })
      : NO_SEEDS;
    // #2568 — production's explore pass, built by the function the
    // orchestrator calls, at production's settings (read cap, transcript).
    const explorePass = productionExplore
      ? buildExploreCodePass({
          search: deps.explorerSearchTools!(),
          providerKey: deps.provider.key,
          model,
        })
      : undefined;
    const tools = explorePass
      ? explorePass.tools
      : explorer
        ? explorerTools(deps.explorerSearchTools!())
        : graph
          ? deps.graphTools(cloneDir, request.toolset === "graph-primitives")
          : [...FILE_ONLY_TOOLS];
    const prompt = buildAgenticPassPrompt({
      projectName: project.name,
      projectDescription: project.description,
      requirements,
      seeds,
      fileToolsAvailable: cloneDir !== undefined,
    });
    const systemMessage = explorePass
      ? explorePass.systemMessage(prompt.systemMessage)
      : explorer
        ? explorerSystemMessage(prompt.systemMessage)
        : graph
          ? prompt.systemMessage
          : filesOnlySystemMessage(prompt.systemMessage);
    const toolContext: ToolContext = {
      projectId: repo.projectId,
      connectorId: repo.connectorId,
      ...(cloneDir ? { cloneDir } : {}),
    };
    const native = resolveAnalysisNativeTools(deps.provider, model, tools);
    // Production's bounds (A3A's, and A21's): the turn cap and the token
    // budget less the seeded blocks.
    const maxTurns = resolveAgenticMaxTurns(requirements.length);
    const tokenBudget = agenticPassEffectiveBudget(resolveAgentTokenBudget(), seeds);
    // #2568 — A21 calls the model through #2569's dollar ceiling, as
    // `runAgenticPass` calls it through `passProvider`.
    const provider = productionExplore
      ? createCodePassCostCeiling({ requirementCount: requirements.length }).guard(deps.provider)
      : deps.provider;
    // #2560 — the explorer's bounds: a long turn cap, no token budget, a wider
    // transcript, and a dollar cap checked before every model call.
    let modelCalls = 0;
    let toolCallsMade = 0;
    // #2560 review — set where the cap throws: the loop's final-answer retry
    // catches every error and degrades, so the throw alone does not stop a
    // pass whose cap is reached at the retry.
    let capReached = false;
    const startedAt = explorer ? deps.spentUsd!() : 0;
    const cap = request.costCapUsd;
    const bounds: Parameters<typeof runAgentLoop>[2] = explorer
      ? {
          maxTurns: EXPLORER_MAX_TURNS,
          transcriptCompaction: {
            ...DEFAULT_TRANSCRIPT_COMPACTION,
            maxTranscriptTokens: EXPLORER_TRANSCRIPT_TOKENS,
          },
          callModel: (messages, opts) => {
            if (cap !== undefined && deps.spentUsd!() - startedAt >= cap) {
              capReached = true;
              throw new PassCostCapReached(cap);
            }
            modelCalls += 1;
            return deps.provider.chat(messages, opts);
          },
          onToolCall: () => {
            toolCallsMade += 1;
          },
          // An answer before any tool call is the seeds restated, not
          // exploration: send it back once to look first.
          continuation: {
            maxNudges: 1,
            nudge: () => (toolCallsMade === 0 ? EXPLORER_NUDGE : null),
          },
        }
      : explorePass
        ? {
            maxTurns,
            maxTokens: tokenBudget,
            onToolCall: () => {
              toolCallsMade += 1;
            },
            // The orchestrator's: the explorer nudge once, before any tool
            // call, then #1388's continuation.
            continuation: explorePass.continuation(
              buildCodePassContinuation({
                requirementIds: requirements.map((r) => r.id),
                isValidFinalAnswer: isSchemaValidFinalAnswer,
              }),
              () => toolCallsMade,
            ),
            transcriptCompaction: explorePass.transcriptCompaction,
          }
        : { maxTurns, maxTokens: tokenBudget };
    // The cap stops the pass with no answer: scored as no citation, and the
    // item's cost (at or past the cap) says why.
    const capped = (): AgentPassResult => ({
      citations: [],
      turns: modelCalls,
      toolCalls: toolCallsMade,
      answered: false,
    });
    let result: AgentLoopResult;
    try {
      result = await runLoop(
        provider,
        { systemMessage, userMessage: prompt.userMessage, tools, toolContext },
        {
          ...(native ? { native } : {}),
          ...bounds,
          model,
          promptCaching: { system: true, messages: true },
          finalAnswerRetry: {
            instruction: FINAL_ANSWER_INSTRUCTION,
            isValidFinalAnswer: isSchemaValidFinalAnswer,
            maxOutputTokens: resolveFinalAnswerMaxOutputTokens(model, deps.provider.key),
            // #2568 — A21's retry is the orchestrator's: its reasoning setting
            // (#1063) and the untruncated evidence (#726).
            ...(explorePass
              ? {
                  reasoning: resolveRecoveryReasoning(model),
                  evidence: (calls: Parameters<typeof buildEvidenceDigest>[0]) =>
                    formatEvidenceForAnswer(
                      buildEvidenceDigest(calls, { maxTokens: DEFAULT_RETRY_EVIDENCE_TOKENS }),
                    ),
                }
              : {}),
          },
        },
      );
    } catch (err) {
      if (err instanceof PassCostCapReached) return capped();
      throw err;
    }
    // Reached at the final-answer retry, the cap was caught inside the loop,
    // which returned its salvage: the pass still has no answer.
    if (capReached) return capped();
    return {
      citations: citationsOfLoop(result),
      turns: result.turnsUsed,
      toolCalls: result.toolCalls.length,
      answered: result.hasFinalAnswer,
      loop: loopStats(result, explorer ? null : tokenBudget),
    };
  };
}
