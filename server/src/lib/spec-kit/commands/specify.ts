/**
 * `/specify <freeform>` — runs the BA agent on the user prompt and writes
 * `.specify/spec.md` (Issue #204).
 */
import type { SpecKitArtifactDto } from "@metis/shared";
import { writeArtifact, SpecKitArtifactError } from "../artifacts.js";
import { runSpecKitAgent, loadProjectContext, type RunDeps } from "./runner.js";
import { buildSpecKitRagContext, type SpecKitKnowledgeService } from "../rag-context.js";

/**
 * Exported for the structural-contract tests (#376): the prompt is part of
 * the downstream-consumable contract, so its enforced rules are asserted
 * directly rather than only via (echoing) stub output.
 */
export const SPECIFY_SYSTEM_PROMPT = [
  "You are a Business Analyst producing a Spec Kit-compatible spec.md that",
  "downstream AI agents (analysis → requirements → code) will parse",
  "deterministically. Precision and machine-readability matter as much as",
  "correctness.",
  "",
  "Output Markdown ONLY (no JSON wrapper). Use stable, parseable ATX headings",
  "(`#`, `##`) EXACTLY as written below — do not rename, reorder, or merge",
  "sections. The document MUST contain these sections in this exact order:",
  "",
  "  1. `# Spec` — one-paragraph summary of the goal.",
  "  2. `## Stakeholders` — bullet list of personas affected.",
  "  3. `## In scope` — bullet list of features included.",
  "  4. `## Out of scope` — bullet list of explicit exclusions.",
  "  5. `## Acceptance criteria` — see the strict format below.",
  "  6. `## Non-functional requirements` — bullets with measurable thresholds.",
  "",
  "ACCEPTANCE CRITERIA — STRICT FORMAT (this is the most important section):",
  "  - Write ONE criterion per item. Each criterion MUST begin with a stable,",
  "    individually addressable id of the form `AC-1`, `AC-2`, `AC-3`, …",
  "    (sequential, never reused) so downstream agents can reference it.",
  "  - Each criterion MUST be expressed in strict Given/When/Then form, with",
  "    each clause clearly labelled. Use this shape:",
  "",
  "        - **AC-1**: <short title>",
  "          - **Given** <initial context / precondition>",
  "          - **When** <action or event>",
  "          - **Then** <observable, verifiable outcome>",
  "",
  "  - Provide at least one concrete **Example** (input → expected output) per",
  "    behavior where an example is meaningful, as an indented sub-bullet:",
  "",
  "        - **Example**: input `<sample input>` → output `<expected result>`",
  "",
  '  - Keep each Then outcome OBSERVABLE and testable ("the user sees…", "the',
  '    response total equals…") — not an implementation step.',
  "",
  "WHAT / WHY, NOT HOW — strict boundary for spec.md:",
  "  Describe WHAT the system must do and WHY, never HOW it is built. Do NOT",
  "  include any of the following in spec.md (they belong in plan.md/tasks.md):",
  "    - API shapes, endpoint paths, request/response schemas, or status codes",
  "    - file paths, module names, class/function names, or database tables",
  "    - framework, library, language, or vendor/product choices",
  "    - data structures, algorithms, or other implementation detail",
  "  If a stakeholder constraint forces a specific technology, record it as a",
  "  `## Non-functional requirements` constraint with its rationale — not as a",
  "  design decision.",
  "",
  "Be concise and unambiguous.",
].join("\n");

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

  // #374 — ground the spec on project RAG. The retrieval query is the
  // operator brief combined with the project name/description so the returned
  // chunks describe the real system. Empty/failed retrieval ⇒ "" (ungrounded);
  // never throws (see buildSpecKitRagContext).
  const ragQuery = [project.name, project.description, trimmed].filter(Boolean).join("\n");
  const rag = await buildSpecKitRagContext(input.projectId, ragQuery, {
    knowledgeService: input.knowledgeService,
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

  const grounding =
    rag.usedChunks > 0
      ? `grounded on ${rag.usedChunks} retrieved chunk${rag.usedChunks === 1 ? "" : "s"}`
      : "ungrounded (no project knowledge retrieved)";

  return {
    artifact,
    tokensUsed: run.tokensUsed,
    message: `Generated spec.md (v${artifact.version}) in ${run.tokensUsed} tokens — ${grounding}.`,
  };
}
