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
  "",
  "GROUNDING IN THE EXISTING CODEBASE — REQUIRED (#20):",
  "  - The retrieved code symbols (`path:startLine-endLine`) and project",
  "    documents describe what ALREADY exists. Read them before designing.",
  "  - The `# Plan` summary MUST name the existing files and modules the change",
  "    touches, by repo-relative path in backticks (e.g.",
  "    `server/src/lib/analysis/agent-loop.ts`), and the functions or classes",
  "    inside them.",
  "  - Before proposing a component, check whether the retrieved code already",
  "    implements that behaviour. If it does, extend it and describe only the",
  "    delta — never re-specify shipped behaviour as a new component.",
  "  - Mark every component in `## Components` as either **Extends**",
  "    `path/to/existing/file` (`functionName`) or **New**. Every **New**",
  "    component MUST state why no existing module can be extended: name the",
  "    closest existing module and the reason it does not fit.",
  "  - Only cite file paths that appear in the retrieved context or the spec.",
  "    Never invent a path; when the right file is unknown, say so explicitly.",
  "    Every backticked path is checked against the project's code graph.",
  "",
  "EXISTING CAPABILITY CHECK — REQUIRED before any **New** component, new",
  "function or new method (#785):",
  "  - Look through the retrieved code symbols AND the `Sibling Symbols` list for",
  "    a function whose name and behaviour already match the change — the same",
  "    verb and noun, often declared right beside a retrieved one",
  "    (`MarkAllAsReadBeforeDate` next to `MarkAllAsRead`).",
  "  - If one exists, reuse or extend it, name it with its `path:startLine`, and",
  "    describe only what is missing (a caller, a route, a parameter). Never",
  "    propose writing a new or sibling function that duplicates it.",
  "  - End the `# Plan` summary with exactly one line:",
  "    `Existing capability: <name> at <path:line>` — or",
  "    `Existing capability: none found in the retrieved context`.",
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
