/**
 * `/specify <freeform>` — runs the BA agent on the user prompt and writes
 * `.specify/spec.md` (Issue #204).
 */
import type { SpecKitArtifactDto } from "@metis/shared";
import { writeArtifact, SpecKitArtifactError } from "../artifacts.js";
import { runSpecKitAgent, loadProjectContext, type RunDeps } from "./runner.js";
import { buildSpecKitRagContext, type SpecKitKnowledgeService } from "../rag-context.js";
import { describeGrounding, PINNED_REQUIREMENT_DOCUMENTS } from "../grounding.js";
import { SPECIFY_SYSTEM_PROMPT } from "./prompts.js";
export { SPECIFY_SYSTEM_PROMPT } from "./prompts.js";

const SYSTEM_PROMPT = SPECIFY_SYSTEM_PROMPT;

export interface SpecifyInput {
  projectId: string;
  prompt: string;
  actorId?: string | null;
  sessionId?: string | null;
  deps?: RunDeps;
  /**
   * Optional injectable knowledge service for RAG grounding (#374). Defaults
   * to the real `getKnowledgeService()` inside `buildSpecKitRagContext`.
   * Tests pass a fake to exercise grounded vs. ungrounded paths.
   */
  knowledgeService?: SpecKitKnowledgeService;
}

export interface SpecifyResult {
  artifact: SpecKitArtifactDto;
  tokensUsed: number;
  message: string;
}

export async function runSpecify(input: SpecifyInput): Promise<SpecifyResult> {
  const trimmed = (input.prompt ?? "").trim();
  if (trimmed.length === 0) {
    throw new SpecKitArtifactError(
      400,
      "SPEC_KIT_EMPTY_INPUT",
      "/specify requires a description after the command word",
    );
  }
  const project = await loadProjectContext(input.projectId);

  // #374 / #20 — ground the spec on project RAG. The retrieval query is the
  // operator brief alone: prepending the project name/description drowned the
  // ask. The top requirements documents are pinned whole so scope can be
  // reconciled against every requirement, not only the chunk top-k happened to
  // return. Empty/failed retrieval ⇒ "" (ungrounded); never throws.
  const rag = await buildSpecKitRagContext(input.projectId, trimmed, {
    knowledgeService: input.knowledgeService,
    expandDocuments: PINNED_REQUIREMENT_DOCUMENTS,
  });

  const userPrompt = [
    `Project: ${project.name}`,
    project.description ? `Description: ${project.description}` : "",
    "",
    "Brief from operator:",
    trimmed,
  ]
    .filter(Boolean)
    .join("\n");

  const run = await runSpecKitAgent({
    command: "specify",
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
    name: "spec.md",
    content: run.content,
    actorId: input.actorId ?? null,
  });

  return {
    artifact,
    tokensUsed: run.tokensUsed,
    message: `Generated spec.md (v${artifact.version}) in ${run.tokensUsed} tokens — ${describeGrounding(rag)}.`,
  };
}
