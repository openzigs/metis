/**
 * Requirement escalation — I/O glue (Issue #739, Epic #727).
 *
 * Turns the extracted requirements of an agentic run into a persisted
 * {@link AnalysisEscalation} decision. It computes the deterministic IMPACT
 * signal (blast-radius size per requirement) by REUSING the exact Impact
 * Analysis machinery #735 uses — `mapRequirementToCode` (BM25 over the project's
 * `CodeSymbol` rows) + `blastRadius` over the code graph — then hands the
 * per-requirement `{ text, blastRadiusSize }` to the PURE scorer/decider in
 * {@link ./escalation-policy}. No new traversal, no LLM call.
 *
 * Design guarantees (mirroring `./affected-code-context.ts`, #735):
 *   - **Env-gated** (`ANALYSIS_ESCALATION_POLICY`, OFF by default). Off ⇒ a clean
 *     no-op: `null` is returned, nothing is persisted, and the agentic pass runs
 *     exactly as it does today (uniform depth).
 *   - **Deterministic**: mapper + blast radius + scorer are all deterministic, so
 *     the same requirements yield the same routing across runs.
 *   - **Degrades cleanly**: any per-requirement impact failure (no graph, mapper
 *     throw) degrades that requirement to `blastRadiusSize = 0` — its ambiguity
 *     score still stands — and NEVER throws, so the analysis run is unaffected.
 */
import type { AnalysisEscalation } from "@metis/shared";
import { getConfigService } from "../config/config-service.js";
import { createChildLogger } from "../logger.js";
import { blastRadius } from "../impact-analysis/blast-radius.js";
import { PrismaCodeGraphDataSource } from "../impact-analysis/impact-analysis-engine.js";
import { mapRequirementToCode } from "../traceability/requirement-code-mapping.js";
import { prisma as defaultPrisma } from "../prisma.js";
import type { AffectedCodeDeps } from "./affected-code-context.js";
import {
  DEFAULT_DEEP_MAX_TURNS,
  DEFAULT_ESCALATION_THRESHOLD,
  DEFAULT_IMPACT_SATURATION,
  DEFAULT_MAX_ESCALATIONS,
  DEFAULT_STANDARD_MAX_TURNS,
  decideEscalations,
  type EscalationPolicyConfig,
  type RequirementEscalationInput,
} from "./escalation-policy.js";

const log = createChildLogger("escalation-context");

/** What the orchestrator needs to persist the decision + drive the passes. */
export interface EscalationContext {
  /** The persisted/surfaced decision record. */
  escalation: AnalysisEscalation;
  /** The resolved policy config (turn caps used to drive the passes). */
  policy: EscalationPolicyConfig;
}

/**
 * Parse a fractional config value. The config service's `getNumber` uses
 * `parseInt` (integers only), so the 0–1 threshold is read as a raw string and
 * `Number`-parsed here, clamped to [0, 1], falling back to `fallback`.
 */
function getFloat(key: string, fallback: number): number {
  const raw = getConfigService().get(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Read the escalation policy config from the config service (with defaults). */
export function readEscalationPolicy(): { enabled: boolean; config: EscalationPolicyConfig } {
  const cfg = getConfigService();
  return {
    enabled: cfg.getBool("ANALYSIS_ESCALATION_POLICY", false),
    config: {
      threshold: getFloat("ANALYSIS_ESCALATION_SCORE_THRESHOLD", DEFAULT_ESCALATION_THRESHOLD),
      maxEscalations: cfg.getNumber(
        "ANALYSIS_ESCALATION_MAX_REQUIREMENTS",
        DEFAULT_MAX_ESCALATIONS,
      ),
      standardMaxTurns: DEFAULT_STANDARD_MAX_TURNS,
      deepMaxTurns: cfg.getNumber("ANALYSIS_ESCALATION_DEEP_MAX_TURNS", DEFAULT_DEEP_MAX_TURNS),
      impactSaturation: cfg.getNumber(
        "ANALYSIS_ESCALATION_IMPACT_SATURATION",
        DEFAULT_IMPACT_SATURATION,
      ),
    },
  };
}

/**
 * Compute the blast-radius size (number of impacted code symbols) for a single
 * requirement: direct mapper hits + transitive blast radius. Reuses #735's
 * mapper + #726's blast-radius traversal. NEVER throws — a failure returns 0.
 */
async function blastRadiusSizeFor(
  requirement: { id: string; text: string },
  projectId: string,
  deps: {
    mapRequirement: NonNullable<AffectedCodeDeps["mapRequirement"]>;
    dataSourceFor: NonNullable<AffectedCodeDeps["dataSourceFor"]>;
  },
): Promise<number> {
  try {
    const matches = await deps.mapRequirement(
      { id: requirement.id, title: requirement.text.slice(0, 120), body: requirement.text },
      projectId,
    );
    const seedIds = matches.map((m) => m.codeSymbolId).filter((id): id is string => Boolean(id));
    if (seedIds.length === 0) return matches.length;
    const topConfidence = matches.reduce((m, c) => Math.max(m, c.confidence), 0);
    const radius = await blastRadius(deps.dataSourceFor(projectId), seedIds, {
      seedConfidence: topConfidence || 1,
    });
    // Direct matches + blast radius (radius excludes the seeds, so no overlap).
    return matches.length + radius.length;
  } catch (err) {
    log.warn("blast-radius impact computation failed for requirement; scoring impact as 0", {
      projectId,
      requirementId: requirement.id,
      error: String(err),
    });
    return 0;
  }
}

/**
 * Compute the escalation decision for a run's extracted requirements. Returns
 * `null` when the policy is disabled or there are no requirements (a clean
 * no-op). NEVER throws.
 */
export async function computeRequirementEscalations(opts: {
  projectId: string;
  requirements: Array<{ id: string; text: string }>;
  deps?: AffectedCodeDeps;
}): Promise<EscalationContext | null> {
  const { enabled, config } = readEscalationPolicy();
  if (!enabled || opts.requirements.length === 0) return null;

  const prisma = opts.deps?.prisma ?? defaultPrisma;
  const mapRequirement: NonNullable<AffectedCodeDeps["mapRequirement"]> =
    opts.deps?.mapRequirement ??
    ((req, projectId) => mapRequirementToCode(req, projectId, {}, { prisma }));
  const dataSourceFor: NonNullable<AffectedCodeDeps["dataSourceFor"]> =
    opts.deps?.dataSourceFor ??
    ((projectId: string) => new PrismaCodeGraphDataSource(prisma, projectId));

  const inputs: RequirementEscalationInput[] = [];
  for (const r of opts.requirements) {
    const blastRadiusSize = await blastRadiusSizeFor(r, opts.projectId, {
      mapRequirement,
      dataSourceFor,
    });
    inputs.push({ id: r.id, text: r.text, blastRadiusSize });
  }

  const requirements = decideEscalations(inputs, config);
  return {
    escalation: {
      enabled: true,
      threshold: config.threshold,
      maxEscalations: config.maxEscalations,
      requirements,
    },
    policy: config,
  };
}
