/**
 * #289 — the persona chip for a finding made by a custom or library agent in
 * the analysis agent phase. The built-in specialists have server personas
 * (`/analyses/personas`); these agents do not, so the chip is built from the
 * agent's own name and kind, which the snapshot carries as `source`.
 *
 * `name` is operator-authored: it is only ever rendered as React text.
 */
import type { AnalysisAgentSource } from "@metis/shared";
import type { PersonaTagPersona } from "./persona-tag";

export const AGENT_SOURCE_ROLE: Record<AnalysisAgentSource["kind"], string> = {
  custom: "Custom agent",
  library: "Library agent",
};

export function agentSourcePersona(source: AnalysisAgentSource): PersonaTagPersona {
  return {
    agentKey: source.ref,
    name: source.name,
    role: AGENT_SOURCE_ROLE[source.kind],
    avatar: "🧩",
  };
}

/** Index the agent-phase rows' personas by their agentKey (the agent ref). */
export function agentSourcePersonas(
  agents: ReadonlyArray<{ agentKey: string; source?: AnalysisAgentSource | null }>,
): Map<string, PersonaTagPersona> {
  const map = new Map<string, PersonaTagPersona>();
  for (const a of agents) if (a.source) map.set(a.agentKey, agentSourcePersona(a.source));
  return map;
}
