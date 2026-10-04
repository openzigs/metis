/**
 * `/plan` — runs the Architect agent against `.specify/spec.md` and writes
 * `.specify/plan.md` (Issue #205). Fails 409 when no spec exists.
 */
import type { SpecKitArtifactDto } from "@metis/shared";
import { getArtifact, writeArtifact, SpecKitArtifactError } from "../artifacts.js";
import { runSpecKitAgent, loadProjectContext, type RunDeps } from "./runner.js";
import {
  buildSpecKitRagContext,
  type SiblingSymbolLookup,
  type SpecKitFusedCodeDeps,
  type SpecKitKnowledgeService,
} from "../rag-context.js";
import {
  describeGrounding,
  extractRequirementText,
  PINNED_REQUIREMENT_DOCUMENTS,
  verifyPlanPaths,
  type PlanPathLookup,
} from "../grounding.js";
import { PLAN_SYSTEM_PROMPT } from "./prompts.js";
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
}

export interface PlanResult {
  artifact: SpecKitArtifactDto;
  tokensUsed: number;
  message: string;
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
  });

  const userPrompt = [
    `Project: ${project.name}`,
    "",
    "Existing spec.md:",
    "```md",
    spec.content,
    "```",
    "",
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

  return {
    artifact,
    tokensUsed: run.tokensUsed,
    message: `Generated plan.md (v${artifact.version}) in ${run.tokensUsed} tokens — ${describeGrounding(rag)}.${pathNote}${noneNote}`,
  };
}
