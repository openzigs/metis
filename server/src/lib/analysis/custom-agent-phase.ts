/**
 * Epic #260 (#81) — custom-agent analysis phase.
 *
 * Runs every custom agent ENABLED for the project (via the
 * `CustomAgentEnablement` join) alongside the built-in specialists during an
 * analysis run. Each agent is invoked through the shared, injection-resistant
 * {@link invokeCustomAgent} path with the project framing as its input — which
 * is the one agent runtime (`agent-runtime/run-agent.ts`) chat sub-agents use
 * too (#129 / #145).
 *
 * Design notes:
 *  - Failures are isolated per-agent: one agent throwing never aborts the
 *    others or the analysis. A failed agent is returned with an `error`.
 *  - Token usage is rolled up so the orchestrator can fold it into the run
 *    totals (and budget accounting).
 *  - Pure + provider-agnostic: fully unit-testable with a mock provider.
 */
import { listEnabledAgentsForProject } from "../custom-agents/index.js";
import { invokeCustomAgent } from "../custom-agents/invoke.js";
import type { AIProvider, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("analysis-custom-agent-phase");

export interface CustomAgentPhaseInput {
  provider: AIProvider;
  projectId: string;
  projectName: string;
  projectDescription: string;
  signal?: AbortSignal;
}

export interface CustomAgentResult {
  agentId: string;
  agentName: string;
  content: string;
  usage: TokenUsage;
  error?: string;
  /** e.g. the agent's saved model could not be used — never silent (#145). */
  warnings?: string[];
}

export interface CustomAgentPhaseResult {
  results: CustomAgentResult[];
  usage: TokenUsage;
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function frameProject(name: string, description: string): string {
  return [
    `Project: ${name}`,
    description.trim() ? `Description: ${description.trim()}` : "Description: (none provided)",
    "",
    "Analyse this project according to your role and return your findings.",
  ].join("\n");
}

export async function runEnabledCustomAgents(
  input: CustomAgentPhaseInput,
): Promise<CustomAgentPhaseResult> {
  if (input.signal?.aborted) {
    return { results: [], usage: { ...ZERO_USAGE } };
  }

  const agents = await listEnabledAgentsForProject(input.projectId);
  if (agents.length === 0) {
    return { results: [], usage: { ...ZERO_USAGE } };
  }

  const framedInput = frameProject(input.projectName, input.projectDescription);
  const totals: TokenUsage = { ...ZERO_USAGE };

  const settled = await Promise.allSettled(
    agents.map(async (agent): Promise<CustomAgentResult> => {
      try {
        const res = await invokeCustomAgent({
          provider: input.provider,
          agent,
          input: framedInput,
          signal: input.signal,
          // #129 — the project's skill allow-list filters the agent's skills.
          projectId: input.projectId,
        });
        return {
          agentId: agent.id,
          agentName: agent.name,
          content: res.content,
          usage: res.usage,
          ...(res.warnings ? { warnings: res.warnings } : {}),
        };
      } catch (err) {
        log.warn("Custom agent failed during analysis", {
          agentId: agent.id,
          error: (err as Error).message,
        });
        return {
          agentId: agent.id,
          agentName: agent.name,
          content: "",
          usage: { ...ZERO_USAGE },
          error: (err as Error).message,
        };
      }
    }),
  );

  const results: CustomAgentResult[] = [];
  for (const s of settled) {
    // allSettled never rejects here (we catch inside), but guard anyway.
    if (s.status === "fulfilled") {
      results.push(s.value);
      if (!s.value.error) {
        totals.promptTokens += s.value.usage.promptTokens;
        totals.completionTokens += s.value.usage.completionTokens;
        totals.totalTokens += s.value.usage.totalTokens;
      }
    }
  }

  return { results, usage: totals };
}
