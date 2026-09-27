/**
 * Epic #260 (#81) — custom-agent analysis phase.
 *
 * Runs every custom agent ENABLED for the project (via the
 * `CustomAgentEnablement` join) — and, since #236, every LIBRARY agent the
 * project has explicitly enabled (an enabled `ProjectAgentAllowlist` row) —
 * alongside the built-in specialists during an analysis run. Each agent is
 * invoked through the shared, injection-resistant {@link invokeAgentDefinition}
 * path with the project framing as its input — which is the one agent runtime
 * (`agent-runtime/run-agent.ts`) chat sub-agents use too (#129 / #145). The
 * run is text only: no tools are offered, because no person is present to
 * approve one.
 *
 * Design notes:
 *  - Failures are isolated per-agent: one agent throwing never aborts the
 *    others or the analysis. A failed agent is returned with an `error`.
 *  - Token usage is rolled up so the orchestrator can fold it into the run
 *    totals (and budget accounting).
 *  - Pure + provider-agnostic: fully unit-testable with a mock provider.
 */
import type { AgentDefinitionDto } from "@metis/shared";
import { listEnabledAgentsForProject } from "../custom-agents/index.js";
import { invokeAgentDefinition } from "../custom-agents/invoke.js";
import { customDtoDefinition, listProjectLibraryAgents } from "../agent-runtime/definition.js";
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
  /** #236 — `library:<id>` or `custom:<id>`. */
  agentRef: string;
  kind: AgentDefinitionDto["kind"];
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

  // Library agents first (explicit opt-in only), then the enabled custom agents.
  const agents: AgentDefinitionDto[] = [
    ...(await listProjectLibraryAgents(input.projectId)),
    ...(await listEnabledAgentsForProject(input.projectId)).map(customDtoDefinition),
  ];
  if (agents.length === 0) {
    return { results: [], usage: { ...ZERO_USAGE } };
  }

  const framedInput = frameProject(input.projectName, input.projectDescription);
  const totals: TokenUsage = { ...ZERO_USAGE };

  const settled = await Promise.allSettled(
    agents.map(async (agent): Promise<CustomAgentResult> => {
      const who = {
        agentId: agent.id,
        agentRef: agent.ref,
        kind: agent.kind,
        agentName: agent.name,
      };
      try {
        const res = await invokeAgentDefinition({
          provider: input.provider,
          definition: agent,
          input: framedInput,
          ...(input.signal ? { signal: input.signal } : {}),
          // #129 — the project's skill allow-list filters the agent's skills.
          projectId: input.projectId,
        });
        return {
          ...who,
          content: res.content,
          usage: res.usage,
          ...(res.warnings ? { warnings: res.warnings } : {}),
        };
      } catch (err) {
        log.warn("Agent failed during analysis", {
          agentRef: agent.ref,
          error: (err as Error).message,
        });
        return {
          ...who,
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
