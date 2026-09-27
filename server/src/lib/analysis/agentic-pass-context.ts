/**
 * #141 / #214 — the agentic code pass's context assembly and token budget, in
 * ONE place, so the orchestrator and the tool-protocol eval harness build the
 * identical pass.
 *
 * Before this module the orchestrator assembled the prompt inline (fused
 * code-graph context #729, the affected-code block #735, the affected-schema
 * block #824) and carved their token cost out of the pass budget inline, while
 * the #214 harness built a bare prompt with none of those blocks and an
 * unreduced budget — so the model had to discover by tool call what production
 * seeds for free, which changes exactly the numbers #214 compares (tool calls,
 * turns, tokens, degraded rate). Both now call {@link buildAgenticPassPrompt}
 * and {@link agenticPassEffectiveBudget}; the harness CLI also computes the
 * seeds with {@link assembleAgenticPassSeeds}, which calls the same three
 * retrievers the orchestrator calls, with the same best-effort degradation.
 */
import {
  type AnalysisDatabaseAware,
  type DatabaseAwareAnalysisSetting,
  DATABASE_AWARE_ANALYSIS_SETTINGS,
  DEFAULT_DATABASE_AWARE_ANALYSIS_SETTING,
} from "@metis/shared";
import { getConfigService } from "../config/config-service.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import {
  computeAffectedCodeContext,
  EMPTY_AFFECTED_CODE_CONTEXT,
  type AffectedCodeContext,
  type AffectedCodeDeps,
} from "./affected-code-context.js";
import {
  computeRunAffectedSchemaContext,
  EMPTY_AFFECTED_SCHEMA_CONTEXT,
  type AffectedSchemaContext,
  type RunAffectedSchemaDeps,
} from "./affected-schema-context.js";
import {
  hasSchemaData as probeHasSchemaData,
  readDbAwareEnvDefault,
  resolveDatabaseAwareAnalysis,
  type SchemaDataPrismaClient,
} from "./database-aware-resolver.js";
import {
  retrieveFusedCodeContext,
  type AnalysisFusedCodeDeps,
  type FusedCodeContext,
} from "./fused-code-chunks.js";
import { buildAgenticCodePrompt } from "./prompts.js";

const log = createChildLogger("analysis-agentic-pass-context");

/** Default token budget per agentic agent loop (100k tokens). */
export const DEFAULT_AGENT_TOKEN_BUDGET = 100_000;

/** The configured per-loop token budget (`ANALYSIS_AGENT_TOKEN_BUDGET`). */
export function resolveAgentTokenBudget(): number {
  return getConfigService().getNumber("ANALYSIS_AGENT_TOKEN_BUDGET", DEFAULT_AGENT_TOKEN_BUDGET);
}

/** The three deterministic blocks seeded into every agentic pass. */
export interface AgenticPassSeeds {
  fused: Pick<FusedCodeContext, "block" | "tokens">;
  affectedCode: Pick<AffectedCodeContext, "block" | "tokens">;
  affectedSchema: Pick<AffectedSchemaContext, "block" | "tokens">;
}

/**
 * The agentic pass's prompt: the requirements plus the fused, affected-code and
 * affected-schema blocks (an empty block is omitted, as before).
 */
export function buildAgenticPassPrompt(input: {
  projectName: string;
  projectDescription: string;
  requirements: Array<{ id: string; text: string }>;
  seeds: AgenticPassSeeds;
  fileToolsAvailable: boolean;
}): { systemMessage: string; userMessage: string } {
  return buildAgenticCodePrompt({
    projectName: input.projectName,
    projectDescription: input.projectDescription,
    requirements: input.requirements,
    retrievedContext: input.seeds.fused.block || undefined,
    affectedCode: input.seeds.affectedCode.block || undefined,
    // #824 — the deterministic AFFECTED SCHEMA block (schema-change awareness).
    affectedSchema: input.seeds.affectedSchema.block || undefined,
    // #777 — tell the agent WHAT IT ACTUALLY HAS. Without this it plans around
    // reading files it can never open and spends turns discovering that.
    fileToolsAvailable: input.fileToolsAvailable,
  });
}

/**
 * The seeded blocks' token cost is carved OUT of the pass budget (never
 * additive); the half-budget floor guards against an absurdly large combined
 * seed so the loop always keeps most of its budget.
 */
export function agenticPassEffectiveBudget(passBudget: number, seeds: AgenticPassSeeds): number {
  return Math.max(
    Math.floor(passBudget / 2),
    passBudget - seeds.fused.tokens - seeds.affectedCode.tokens - seeds.affectedSchema.tokens,
  );
}

/**
 * #855 — the per-project database-aware decision WITHOUT persisting it (the
 * orchestrator persists the returned record on the analysis). Best-effort: a
 * schema-data probe failure degrades to "no schema data" (fail closed).
 */
export async function resolveDatabaseAwareDecision(
  projectId: string,
  settingRaw: string | undefined,
  logContext: Record<string, unknown> = {},
): Promise<AnalysisDatabaseAware> {
  const settings: readonly string[] = DATABASE_AWARE_ANALYSIS_SETTINGS;
  const setting: DatabaseAwareAnalysisSetting = settings.includes(settingRaw ?? "")
    ? (settingRaw as DatabaseAwareAnalysisSetting)
    : DEFAULT_DATABASE_AWARE_ANALYSIS_SETTING;

  // #849 — read via the shared helper so the run path and the gap-report
  // path apply the identical default (ON) and the identical
  // explicitly-configured probe (`describeSource`).
  const envDefault = readDbAwareEnvDefault(getConfigService());

  let dataPresent = false;
  try {
    dataPresent = await probeHasSchemaData(prisma as unknown as SchemaDataPrismaClient, projectId);
  } catch (err) {
    log.warn("Database-aware schema-data probe failed; degrading to no schema data", {
      ...logContext,
      projectId,
      error: (err as Error).message,
    });
  }

  const resolved = resolveDatabaseAwareAnalysis({
    setting,
    envDefault,
    hasSchemaData: dataPresent,
  });
  return { setting, ...resolved };
}

/**
 * Compute a pass's seeds the way the orchestrator does, for a caller that has
 * no orchestrator run (the #214 harness CLI). Each retriever degrades to its
 * empty context on error, exactly as the orchestrator's wrappers do.
 */
export async function assembleAgenticPassSeeds(input: {
  projectId: string;
  projectName: string;
  projectDescription: string;
  extraInstructions?: string;
  requirements: Array<{ id: string; text: string }>;
  /** The resolved database-aware decision (see {@link resolveDatabaseAwareDecision}). */
  databaseAware: boolean;
  deps?: {
    fusedCode?: AnalysisFusedCodeDeps;
    affectedCode?: AffectedCodeDeps;
    affectedSchema?: RunAffectedSchemaDeps;
  };
}): Promise<AgenticPassSeeds> {
  const affectedCode = await computeAffectedCodeContext({
    projectId: input.projectId,
    extraInstructions: input.extraInstructions,
    deps: input.deps?.affectedCode,
  }).catch((err: unknown) => {
    log.warn("Affected-code mapping failed; degrading to no-op", {
      error: (err as Error).message,
    });
    return EMPTY_AFFECTED_CODE_CONTEXT;
  });
  const affectedSchema = await computeRunAffectedSchemaContext({
    projectId: input.projectId,
    extraInstructions: input.extraInstructions,
    enabled: input.databaseAware,
    deps: input.deps?.affectedSchema,
  }).catch((err: unknown) => {
    log.warn("Affected-schema mapping failed; degrading to no-op", {
      error: (err as Error).message,
    });
    return EMPTY_AFFECTED_SCHEMA_CONTEXT;
  });
  const fused = await retrieveFusedCodeContext({
    projectId: input.projectId,
    projectName: input.projectName,
    projectDescription: input.projectDescription,
    extraInstructions: input.extraInstructions,
    requirements: input.requirements,
    ragChunks: [],
    deps: input.deps?.fusedCode,
  });
  return { fused, affectedCode, affectedSchema };
}
