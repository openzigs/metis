/**
 * `/plan` — runs the Architect agent against `.specify/spec.md` and writes
 * `.specify/plan.md` (Issue #205). Fails 409 when no spec exists.
 */
import type { SpecKitArtifactDto } from "@metis/shared";
import { getArtifact, writeArtifact, SpecKitArtifactError } from "../artifacts.js";
import { runSpecKitAgent, loadProjectContext, type RunDeps } from "./runner.js";
import { buildSpecKitRagContext, type SpecKitKnowledgeService } from "../rag-context.js";

/**
 * Exported for the structural-contract tests (#376) — see specify.ts.
 */
export const PLAN_SYSTEM_PROMPT = [
  "You are a Solution Architect producing a Spec Kit-compatible plan.md that",
  "downstream AI agents will parse deterministically. Every design choice MUST",
  "be traceable back to the spec it satisfies.",
  "",
  "Output Markdown ONLY. Use stable, parseable ATX headings EXACTLY as written",
  "below — do not rename, reorder, or merge sections. The document MUST contain",
  "these sections in this order:",
  "",
  "  1. `# Plan` — paragraph summary of the technical approach.",
  "  2. `## Components` — bullets of named components and their responsibility.",
  "  3. `## Architecture diagram` — ONE Mermaid `graph` block (required).",
  "  4. `## Sequence diagrams` — zero or more Mermaid `sequenceDiagram` blocks.",
  "  5. `## ADRs` — bulleted Architecture Decision Records (Decision / Rationale).",
  "  6. `## Risks & mitigations` — bullets pairing each risk with its mitigation.",
  "",
  "TRACEABILITY — REQUIRED:",
  "  - Reference acceptance criteria by their STABLE id (`AC-1`, `AC-2`, …) as",
  "    written in spec.md — NOT by section name or paraphrase.",
  "  - Every component in `## Components` MUST end with the AC id(s) it",
  "    satisfies, e.g.:",
  "",
  "        - **BillingLedger** — accrues line-item charges. (satisfies: AC-2, AC-3)",
  "",
  "  - Every ADR in `## ADRs` MUST cite the AC id(s) driving the decision, e.g.:",
  "",
  "        - **Decision**: use append-only event log. **Rationale**: … (satisfies: AC-4)",
  "",
  "  - Collectively the components/ADRs SHOULD cover every AC id in spec.md;",
  "    note any AC deliberately deferred and why.",
  "",
  "The `## Architecture diagram` section MUST contain exactly one fenced",
  "```mermaid``` block — never omit it.",
].join("\n");

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

  // #375 — ground the plan on project RAG. The retrieval query combines the
  // spec content with architecture-oriented terms so the returned chunks
  // describe the real components/modules the plan must fit into. Empty/failed
  // retrieval ⇒ "" (ungrounded); never throws (see buildSpecKitRagContext).
  const ragQuery = [
    project.name,
    "architecture components modules services data flow dependencies integrations",
    spec.content,
  ]
    .filter(Boolean)
    .join("\n");
  const rag = await buildSpecKitRagContext(input.projectId, ragQuery, {
    knowledgeService: input.knowledgeService,
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

  const grounding =
    rag.usedChunks > 0
      ? `grounded on ${rag.usedChunks} retrieved chunk${rag.usedChunks === 1 ? "" : "s"}`
      : "ungrounded (no project knowledge retrieved)";

  return {
    artifact,
    tokensUsed: run.tokensUsed,
    message: `Generated plan.md (v${artifact.version}) in ${run.tokensUsed} tokens — ${grounding}.`,
  };
}
