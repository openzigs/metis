/**
 * Named personas for the multi-agent analysis pipeline (Phase 7 / R-A3).
 *
 * BMAD-METHOD inspired defaults: each specialist has a name, role, avatar
 * glyph, and one-line description that the UI surfaces in the analysis tab.
 * Deployments can override any of the names by setting environment variables
 * (`ANALYSIS_PERSONA_DOCUMENT_NAME`, etc.) — the values are read at startup.
 */
import type { AnalysisPersona } from "@metis/shared";
import { ANALYSIS_AGENT_KEYS, type AnalysisAgentKey } from "@metis/shared";

const DEFAULT_PERSONAS: Record<AnalysisAgentKey, AnalysisPersona> = {
  document: {
    agentKey: "document",
    name: "Mary",
    role: "Business Analyst",
    avatar: "📄",
    description: "Reads scope documents to surface business goals, stakeholders, and rules.",
  },
  code: {
    agentKey: "code",
    name: "Winston",
    role: "Solution Architect",
    avatar: "🏛️",
    description: "Examines source code to identify components, APIs, and architectural impact.",
  },
  database: {
    agentKey: "database",
    name: "Sally",
    role: "Domain / Data Modeler",
    avatar: "🗄️",
    description: "Inspects schemas to flag data-model and migration requirements.",
  },
  web: {
    agentKey: "web",
    name: "Quinn",
    role: "Risk / Compliance Researcher",
    avatar: "🔎",
    description: "Researches industry standards, regulations, and risk for the project domain.",
  },
  synthesis: {
    agentKey: "synthesis",
    name: "Synthesis",
    role: "Reviewer",
    avatar: "✨",
    description: "Cross-checks specialist findings, dedupes, and emits structured requirements.",
  },
};

const ENV_KEY_PREFIX: Record<AnalysisAgentKey, string> = {
  document: "ANALYSIS_PERSONA_DOCUMENT",
  code: "ANALYSIS_PERSONA_CODE",
  database: "ANALYSIS_PERSONA_DATABASE",
  web: "ANALYSIS_PERSONA_WEB",
  synthesis: "ANALYSIS_PERSONA_SYNTHESIS",
};

const trimOr = (raw: string | undefined, fallback: string): string => {
  if (raw == null) return fallback;
  const t = raw.trim();
  return t.length === 0 ? fallback : t;
};

/**
 * Resolve the persona for an agent, applying any env overrides at call time.
 * Pure function — safe to call from request handlers without caching.
 */
export function getPersona(agentKey: AnalysisAgentKey): AnalysisPersona {
  const base = DEFAULT_PERSONAS[agentKey];
  const prefix = ENV_KEY_PREFIX[agentKey];
  return {
    agentKey,
    name: trimOr(process.env[`${prefix}_NAME`], base.name),
    role: trimOr(process.env[`${prefix}_ROLE`], base.role),
    avatar: trimOr(process.env[`${prefix}_AVATAR`], base.avatar),
    description: trimOr(process.env[`${prefix}_DESCRIPTION`], base.description),
  };
}

/** Snapshot of every persona — used by `/api/analyses/personas`. */
export function getAllPersonas(): AnalysisPersona[] {
  return ANALYSIS_AGENT_KEYS.map(getPersona);
}
