/**
 * `/plan` — runs the Architect agent against `.specify/spec.md` and writes
 * `.specify/plan.md` (Issue #205). Fails 409 when no spec exists.
 */
import type { SpecKitArtifactDto } from "@metis/shared";
import { getArtifact, writeArtifact, SpecKitArtifactError } from "../artifacts.js";
import {
  runSpecKitAgent,
  loadProjectContext,
  keepsPriorVersion,
  truncationWarning,
  type RunDeps,
} from "./runner.js";
import {
  buildSpecKitRagContext,
  type CallerLookup,
  type SiblingSymbolLookup,
  type SpecKitFusedCodeDeps,
  type SpecKitKnowledgeService,
} from "../rag-context.js";
import {
  describeContextDropped,
  describeGrounding,
  extractRequirementText,
  PINNED_REQUIREMENT_DOCUMENTS,
  verifyPlanPaths,
  type PlanPathLookup,
} from "../grounding.js";
import type { PlanLocalisationSource } from "../plan-localisation.js";
import { PLAN_SYSTEM_PROMPT } from "./prompts.js";
import { describeUndeclaredMermaidNodes, findUndeclaredMermaidNodes } from "../mermaid-check.js";
import { describePlanDesignDiff, diffPlanDesign, previousPlanSection } from "../plan-diff.js";
import {
  createDefaultSymbolFileLookup,
  describeNotVisibleClaims,
  describeParameterRenames,
  findNotVisibleClaims,
  findParameterRenames,
  type SymbolFileLookup,
} from "../plan-checks.js";
export { PLAN_SYSTEM_PROMPT } from "./prompts.js";

const SYSTEM_PROMPT = PLAN_SYSTEM_PROMPT;

export interface PlanInput {
  projectId: string;
  actorId?: string | null;
  sessionId?: string | null;
  deps?: RunDeps;
  /**
   * Optional injectable knowledge service for RAG grounding (#375). Defaults
   * to the real `getKnowledgeService()` inside `buildSpecKitRagContext`.
   * Tests pass a fake to exercise grounded vs. ungrounded paths.
   */
  knowledgeService?: SpecKitKnowledgeService;
  /** #20 — injectable code-graph retrieval. Defaults to the production wiring. */
  fusedCode?: SpecKitFusedCodeDeps;
  /** #20 — injectable code-graph path lookup for the post-generation check. */
  pathLookup?: PlanPathLookup;
  /** #785 — injectable same-file sibling lookup. Defaults to the production wiring. */
  siblingLookup?: SiblingSymbolLookup;
  /** #944 — injectable caller lookup. Defaults to the production wiring. */
  callerLookup?: CallerLookup;
  /** #1060 — injectable code-graph source for the localisation. Defaults to the production wiring. */
  localisationSource?: PlanLocalisationSource;
  /** #1135 — injectable function → file lookup for the "not visible" check. */
  symbolFileLookup?: SymbolFileLookup;
}

export interface PlanResult {
  artifact: SpecKitArtifactDto;
  tokensUsed: number;
  message: string;
  /**
   * #1060 — every repository file the plan's context named. A file absent from
   * it was not retrieved. Returned to the in-process caller only: the
   * project-level `.specify/` set has a closed list of artifact names, and the
   * deprecated `/plan` route's response shape is frozen. `/speckit.plan` stores
   * the list as `plan-context.md`.
   */
  retrievedFiles: string[];
  /**
   * #1057 — the cut-off reply, set only when it was NOT saved because a
   * complete plan.md already existed (that version stays current).
   */
  partialContent?: string;
}

export async function runPlan(input: PlanInput): Promise<PlanResult> {
  const spec = await getArtifact(input.projectId, "spec.md");
  if (!spec || spec.content.trim().length === 0) {
    throw new SpecKitArtifactError(
      409,
      "SPEC_KIT_PLAN_NEEDS_SPEC",
      "Run /specify first — no spec.md found in .specify/",
    );
  }
  const project = await loadProjectContext(input.projectId);
  // #1134 — a re-run revises the current plan instead of designing afresh.
  const storedPlan = await getArtifact(input.projectId, "plan.md");
  const previousPlan = storedPlan && storedPlan.content.trim().length > 0 ? storedPlan : null;

  // #375 / #20 — ground the plan on project RAG and the code graph. The query
  // is the spec's own requirement text: the project name and generic
  // architecture vocabulary it used to carry drowned the ask and retrieved
  // unrelated files. Code symbols are always retrieved here (a plan must name
  // the files it changes), and the top requirements documents are pinned whole
  // so no requirement below their first chunk is lost. Empty/failed retrieval
  // ⇒ "" (ungrounded); never throws (see buildSpecKitRagContext).
  const rag = await buildSpecKitRagContext(input.projectId, extractRequirementText(spec.content), {
    knowledgeService: input.knowledgeService,
    fusedCode: input.fusedCode,
    includeCode: true,
    expandDocuments: PINNED_REQUIREMENT_DOCUMENTS,
    // #785 — list the existing same-file siblings of every retrieved symbol.
    siblings: { ...(input.siblingLookup ? { lookup: input.siblingLookup } : {}) },
    // #944 — and the code that already calls them: a plan missed the
    // protocol-adapter writers of the table it changed.
    callers: { ...(input.callerLookup ? { lookup: input.callerLookup } : {}) },
    // #1060 — and down the code graph to the data that code touches: the
    // migration, the table's writers, the query builder and the client struct
    // share no word with a spec, so similarity never retrieved them.
    localise: { ...(input.localisationSource ? { source: input.localisationSource } : {}) },
  });

  const userPrompt = [
    `Project: ${project.name}`,
    "",
    "Existing spec.md:",
    "```md",
    spec.content,
    "```",
    "",
    ...(previousPlan ? [previousPlanSection(previousPlan), ""] : []),
    "Produce plan.md per the system instructions.",
  ].join("\n");

  const run = await runSpecKitAgent({
    command: "plan",
    project,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: input.deps,
    ragContext: rag.context,
    ragChunksUsed: rag.usedChunks,
  });

  // #1057 — a cut-off reply never replaces a complete plan.md: the stored
  // version stays current and the partial text is returned to the caller.
  const prior = run.truncated ? previousPlan : null;
  if (prior && keepsPriorVersion(run.truncated, prior)) {
    return {
      artifact: prior,
      tokensUsed: run.tokensUsed,
      retrievedFiles: rag.files,
      partialContent: run.content,
      message: `plan.md was cut off at the model's output-token limit, so the complete plan.md (v${prior.version}) is kept as current and the partial reply was not saved — re-run the command or split the request.`,
    };
  }

  const artifact = await writeArtifact({
    projectId: input.projectId,
    name: "plan.md",
    content: run.content,
    actorId: input.actorId ?? null,
  });

  // #20 — an invented path is reported, not trusted.
  const paths = await verifyPlanPaths(input.projectId, run.content, input.pathLookup);
  // PR #419 review — the note must fire on the exact #20 failure (no existing
  // file named at all), and must not call a planned NEW file "invented".
  const existingNamed = paths.referenced.length - paths.unverified.length;
  const noneNote =
    paths.checked && existingNamed === 0
      ? " The plan names no existing file from the project's code graph — check where the change goes before implementing."
      : "";
  const pathNote =
    paths.unverified.length > 0
      ? ` ${paths.unverified.length} referenced path${paths.unverified.length === 1 ? " is" : "s are"} not in the project's code graph (expected only for new files): ${paths.unverified.map((p) => `\`${p}\``).join(", ")}.`
      : "";

  // #944 — a diagram edge to a node nobody declared is reported, not drawn silently.
  const mermaidNote = describeUndeclaredMermaidNodes(
    "plan.md",
    findUndeclaredMermaidNodes(run.content),
  );

  const designNote = previousPlan
    ? describePlanDesignDiff(
        previousPlan.version,
        diffPlanDesign(previousPlan.content, run.content),
      )
    : "";
  // #1135 — the same checks as `/speckit.plan`. `/plan` keeps no plan-context.md,
  // so the files are named as "the plan's context".
  const checkNote =
    describeNotVisibleClaims(
      await findNotVisibleClaims(
        run.content,
        rag,
        input.symbolFileLookup ?? createDefaultSymbolFileLookup(input.projectId),
      ),
      null,
    ) + describeParameterRenames(findParameterRenames(spec.content, run.content));

  return {
    artifact,
    tokensUsed: run.tokensUsed,
    retrievedFiles: rag.files,
    message: `Generated plan.md (v${artifact.version}) in ${run.tokensUsed} tokens — ${describeGrounding(rag)}.${designNote}${describeContextDropped(rag.dropped)}${pathNote}${noneNote}${mermaidNote}${checkNote}${truncationWarning(run.truncated ? ["plan.md"] : [])}`,
  };
}
