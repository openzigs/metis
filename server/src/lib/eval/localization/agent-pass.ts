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
  extractJsonObject,
  resolveFinalAnswerMaxOutputTokens,
} from "../../analysis/agent-runner.js";
import {
  agenticPassEffectiveBudget,
  buildAgenticPassPrompt,
  resolveAgentTokenBudget,
  resolveAgenticMaxTurns,
  type AgenticPassSeeds,
} from "../../analysis/agentic-pass-context.js";
import { listFilesTool } from "../../analysis/tools/list-files.js";
import { readFileSliceTool } from "../../analysis/tools/read-file-slice.js";
import type { AgentTool, ToolContext } from "../../analysis/tools/types.js";
import {
  citationTargets,
  DEFAULT_SEED_CONFIDENCE,
} from "../../traceability/seed-code-links-from-findings.js";
import type { AgentCitation, AgentPass, AgentPassRequest, AgentPassResult } from "./arm-core.js";
import { grepFilesTool } from "./grep-files-tool.js";
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
  /** The orchestrator's `assembleAgenticCodeTools` for a verified clone directory. */
  graphTools: (cloneDir: string | undefined) => AgentTool[];
  /** `extractNewRequirementCandidates`. */
  extractRequirements: (text: string) => Promise<Array<{ id: string; text: string }>>;
  /** `runAgentLoop`; a seam for tests. */
  runLoop?: typeof runAgentLoop;
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

/** Production's investigation steps with a working tree (`buildAgenticCodePrompt`). */
const GRAPH_STEPS = [
  "- Start by searching the code graph for relevant symbols (classes, functions, interfaces)",
  "- Use read_file_slice to examine specific implementations",
  "- Use list_files to discover project structure when needed",
  "- Use search_knowledge to find additional documentation context",
].join("\n");

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
 * #1819 — the CLI's preflight for A3N: every materialized repository's clone is
 * on disk. The pass checks it too, but only at its first A3N reading, after
 * run 1's A3 and A3A passes are paid for; this check runs before any spend.
 */
export async function assertA3NClones(
  states: ReadonlyMap<string, Pick<MaterializedState, "repos">>,
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
      `A3N needs every repository's clone, and these are not directories:\n  - ${missing.join("\n  - ")}`,
    );
  }
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
    const graph = request.toolset === "graph";
    // #1810 — the file tools read only the clone. Without it every A3N call
    // fails, and the pass would score about 0 at full cost; the graph pass runs
    // without a working tree, as production does.
    if (!graph && cloneDir === undefined) {
      throw new Error(
        `A3N needs the clone of ${request.corpus}/${request.repo}, and ${repo.cloneDir} is not a directory: run pnpm eval:materialize ${request.corpus}`,
      );
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
    const tools = graph ? deps.graphTools(cloneDir) : [...FILE_ONLY_TOOLS];
    const prompt = buildAgenticPassPrompt({
      projectName: project.name,
      projectDescription: project.description,
      requirements,
      seeds,
      fileToolsAvailable: cloneDir !== undefined,
    });
    const systemMessage = graph
      ? prompt.systemMessage
      : filesOnlySystemMessage(prompt.systemMessage);
    const toolContext: ToolContext = {
      projectId: repo.projectId,
      connectorId: repo.connectorId,
      ...(cloneDir ? { cloneDir } : {}),
    };
    const native = resolveAnalysisNativeTools(deps.provider, model, tools);
    const result = await runLoop(
      deps.provider,
      { systemMessage, userMessage: prompt.userMessage, tools, toolContext },
      {
        ...(native ? { native } : {}),
        maxTurns: resolveAgenticMaxTurns(requirements.length),
        maxTokens: agenticPassEffectiveBudget(resolveAgentTokenBudget(), seeds),
        model,
        promptCaching: { system: true, messages: true },
        finalAnswerRetry: {
          instruction: FINAL_ANSWER_INSTRUCTION,
          isValidFinalAnswer: isSchemaValidFinalAnswer,
          maxOutputTokens: resolveFinalAnswerMaxOutputTokens(model, deps.provider.key),
        },
      },
    );
    return {
      citations: citationsOfLoop(result),
      turns: result.turnsUsed,
      toolCalls: result.toolCalls.length,
      answered: result.hasFinalAnswer,
    };
  };
}
