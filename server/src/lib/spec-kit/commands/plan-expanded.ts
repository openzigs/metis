/**
 * Epic #396 (MVP-6) — `/speckit.plan` Phase 0 + Phase 1 expansion.
 *
 * Emits five artifacts under `specs/<slug>/`:
 *   - `plan.md`         — the technical plan + Constitution Compliance Check.
 *   - `research.md`     — Phase 0 resolved unknowns (always emitted).
 *   - `data-model.md`   — Phase 1 ER / domain model.
 *   - `contracts/api.openapi.yaml` — Phase 1 API surface (OpenAPI 3.1).
 *   - `quickstart.md`   — how a developer runs the feature locally.
 *
 * Hard precondition (412): constitution must exist (`constitution_required`).
 * Other gates: feature must have spec.md (specGate).
 *
 * The OpenAPI body is generated from the plan + spec by the Architect
 * agent; this module post-processes it to ensure it lints clean.
 */
import yaml from "js-yaml";
import {
  writeFeatureArtifact,
  getFeatureArtifact,
  type FeatureArtifactDto,
} from "../feature-artifacts.js";
import { resolveFeatureBySlug, updateFeatureStatus } from "../features.js";
import { requireGate, GateUnmetError } from "../gates.js";
import { loadAsPreamble } from "../constitution-meta.js";
import { runSpecKitAgent, loadProjectContext, truncationWarning, type RunDeps } from "./runner.js";
import { SpecKitArtifactError } from "../artifacts.js";
import { PLAN_SYSTEM_PROMPT as LEGACY_PLAN_SYSTEM_PROMPT } from "./prompts.js";
import { describeUndeclaredMermaidNodes, findUndeclaredMermaidNodes } from "../mermaid-check.js";
import {
  buildSpecKitRagContext,
  type CallerLookup,
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
 * #786 — the `/plan` contract (AC-id traceability, grounding in the existing
 * code, the #785 existing-capability check) plus the per-feature compliance
 * section. It used to be a seven-line prompt that cited ACs "by section name"
 * and never mentioned the codebase.
 */
const PLAN_SYSTEM_PROMPT = [
  LEGACY_PLAN_SYSTEM_PROMPT,
  "",
  "CONSTITUTION — REQUIRED: after `## Risks & mitigations`, add a seventh section",
  "`## Constitution Compliance Check` — a table of the constitution's principles",
  "against pass / fail / n/a for this plan.",
].join("\n");

const RESEARCH_SYSTEM_PROMPT = [
  "You are a Solution Architect emitting Spec Kit Phase 0 research.md.",
  "",
  "Output Markdown ONLY. The document MUST contain in order:",
  "  1. `# Research` — one-paragraph summary of unknowns identified by the BA.",
  "  2. `## Resolved Unknowns` — bullets, one per `[NEEDS CLARIFICATION]` marker in spec.md;",
  "      if no markers exist, output exactly: `## Resolved Unknowns: none`.",
  "  3. `## Open Questions` — bullets of items still requiring stakeholder input.",
].join("\n");

const DATA_MODEL_SYSTEM_PROMPT = [
  "You are a Solution Architect emitting Spec Kit Phase 1 data-model.md.",
  "",
  "Output Markdown ONLY. The document MUST contain:",
  "  1. `# Data Model` — paragraph summary.",
  "  2. `## Entities` — table with `Entity | Field | Type | Notes` columns.",
  "  3. `## Relationships` — bullets describing FK / cardinality.",
  "  4. `## ER Diagram` — ONE Mermaid `erDiagram` block.",
].join("\n");

const QUICKSTART_SYSTEM_PROMPT = [
  "You are a Solution Architect emitting Spec Kit Phase 1 quickstart.md.",
  "",
  "Output Markdown ONLY. The document MUST contain:",
  "  1. `# Quickstart` — what the feature does + who it's for.",
  "  2. `## Prerequisites` — bullets of required tools / accounts / env vars.",
  "  3. `## Run locally` — numbered steps, one shell command per line.",
  "  4. `## Verify` — assertions the developer can make to confirm the feature works.",
].join("\n");

const CONTRACT_SYSTEM_PROMPT = [
  "You are a Solution Architect emitting an OpenAPI 3.1 contract.",
  "",
  "Output **YAML ONLY** (no markdown fences, no prose). The document MUST be a",
  "valid OpenAPI 3.1.0 specification with at minimum: `openapi: 3.1.0`, `info`",
  "(title + version), and at least one path operation derived from the feature's",
  "API surface. If the feature has no API surface, emit a stub with a single",
  "`/health` GET that returns 200.",
].join("\n");

export interface PlanInput {
  projectId: string;
  featureSlug: string;
  /** Bypass the specGate (audit-emitted high-severity event). */
  force?: boolean;
  actorId?: string | null;
  sessionId?: string | null;
  deps?: RunDeps;
  /** #786 — injectable retrieval seams (default: the production wiring), as `/plan`. */
  knowledgeService?: SpecKitKnowledgeService;
  fusedCode?: SpecKitFusedCodeDeps;
  siblingLookup?: SiblingSymbolLookup;
  /** #944 — injectable caller lookup. Defaults to the production wiring. */
  callerLookup?: CallerLookup;
  pathLookup?: PlanPathLookup;
}

export interface PlanResult {
  artifacts: FeatureArtifactDto[];
  message: string;
  tokensUsed: number;
}

export async function runPlanExpanded(input: PlanInput): Promise<PlanResult> {
  const feature = await resolveFeatureBySlug(input.projectId, input.featureSlug);
  if (!feature) {
    throw new SpecKitArtifactError(
      404,
      "SPECKIT_FEATURE_NOT_FOUND",
      `Feature not found: ${input.featureSlug}`,
    );
  }
  // Hard 412: constitution required before any plan can be emitted.
  const preamble = await loadAsPreamble(input.projectId);
  if (!preamble) {
    throw new GateUnmetError(
      "specGate",
      "constitution_required — run /speckit.constitution before /speckit.plan",
    );
  }
  await requireGate({
    featureId: feature.id,
    gate: "specGate",
    force: input.force ?? false,
    actorId: input.actorId ?? null,
    command: "speckit.plan",
  });

  const spec = await getFeatureArtifact(feature.id, "spec.md");
  if (!spec) {
    throw new GateUnmetError("specGate", "spec.md is required — run /speckit.specify first");
  }
  const project = await loadProjectContext(input.projectId);

  // #786 — ground every artifact the way `/plan` is grounded (#375 / #20 /
  // #785): retrieve on the spec's own requirement text, always include code
  // symbols with their same-file siblings, and pin the top requirements
  // documents whole. One retrieval serves all five calls, and the block sits in
  // the cached system prefix right after the constitution. Empty or failed
  // retrieval ⇒ "" (ungrounded); never throws.
  const rag = await buildSpecKitRagContext(input.projectId, extractRequirementText(spec.content), {
    knowledgeService: input.knowledgeService,
    fusedCode: input.fusedCode,
    includeCode: true,
    expandDocuments: PINNED_REQUIREMENT_DOCUMENTS,
    siblings: { ...(input.siblingLookup ? { lookup: input.siblingLookup } : {}) },
    // #944 — and the code that already calls them: a plan missed the
    // protocol-adapter writers of the table it changed.
    callers: { ...(input.callerLookup ? { lookup: input.callerLookup } : {}) },
  });

  const userBase = [
    `Feature: ${feature.slug} — ${feature.title}`,
    "",
    "spec.md:",
    "```md",
    spec.content,
    "```",
  ].join("\n");

  const artifacts: FeatureArtifactDto[] = [];
  let totalTokens = 0;
  // #944 — artifacts whose reply the output cap still cut off.
  const truncated: string[] = [];
  const generate = async (key: string, systemPrompt: string, ask: string): Promise<string> => {
    const format = key.endsWith(".yaml") ? ("yaml" as const) : ("markdown" as const);
    const run = await runSpecKitAgent({
      command: "plan",
      project,
      systemPrompt,
      userPrompt: `${userBase}\n\n${ask}`,
      actorId: input.actorId ?? null,
      sessionId: input.sessionId ?? null,
      deps: input.deps,
      ragContext: rag.context,
      ragChunksUsed: rag.usedChunks,
      format,
    });
    totalTokens += run.tokensUsed;
    if (run.truncated) truncated.push(key);
    return run.content;
  };
  const write = async (key: string, content: string): Promise<void> => {
    artifacts.push(
      await writeFeatureArtifact({
        featureId: feature.id,
        key,
        content,
        actorId: input.actorId ?? null,
      }),
    );
  };

  // Phase 0 — research.md (always emitted).
  let researchContent = await generate(
    "research.md",
    RESEARCH_SYSTEM_PROMPT,
    "Produce research.md per the system instructions.",
  );
  const noClarMarkers = !/\[NEEDS CLARIFICATION\]/.test(spec.content);
  if (noClarMarkers && !/^##\s+Resolved Unknowns/m.test(researchContent)) {
    researchContent = `${researchContent.trim()}\n\n## Resolved Unknowns: none\n`;
  }
  await write("research.md", researchContent);

  // Phase 1 — data-model.md
  await write(
    "data-model.md",
    await generate(
      "data-model.md",
      DATA_MODEL_SYSTEM_PROMPT,
      "Produce data-model.md per the system instructions.",
    ),
  );

  // Phase 1 — contracts/api.openapi.yaml
  const contract = await generate(
    "contracts/api.openapi.yaml",
    CONTRACT_SYSTEM_PROMPT,
    "Produce the OpenAPI 3.1 contract per the system instructions.",
  );
  await write("contracts/api.openapi.yaml", ensureValidOpenAPI(contract, feature.slug));

  // Phase 1 — quickstart.md
  await write(
    "quickstart.md",
    await generate(
      "quickstart.md",
      QUICKSTART_SYSTEM_PROMPT,
      "Produce quickstart.md per the system instructions.",
    ),
  );

  // Plan.md (last — references the others).
  let planContent = await generate(
    "plan.md",
    PLAN_SYSTEM_PROMPT,
    "Produce plan.md per the system instructions.",
  );
  if (!/^##\s+Constitution Compliance Check/m.test(planContent)) {
    planContent = `${planContent.trim()}\n\n## Constitution Compliance Check\n\n| Principle | Status | Notes |\n| --- | --- | --- |\n| (auto-generated) | n/a | populate per principle from .specify/memory/constitution.md |\n`;
  }
  await write("plan.md", planContent);

  await updateFeatureStatus(feature.id, "planned", input.actorId ?? null);

  // #786 — the same post-generation path check as `/plan` (#20): an invented
  // path is reported, never trusted.
  const paths = await verifyPlanPaths(input.projectId, planContent, input.pathLookup);
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
  const mermaidNote = artifacts
    .filter((a) => a.key.endsWith(".md"))
    .map((a) => describeUndeclaredMermaidNodes(a.key, findUndeclaredMermaidNodes(a.content)))
    .join("");

  return {
    artifacts,
    message: `Generated 5 plan artifacts for ${feature.slug} (${totalTokens} tokens) — ${describeGrounding(rag)}.${pathNote}${noneNote}${mermaidNote}${truncationWarning(truncated)}`,
    tokensUsed: totalTokens,
  };
}

/**
 * Ensure the model output is a valid OpenAPI 3.1 YAML. Strips markdown
 * fences, parses with js-yaml, and ensures the document has the required
 * top-level keys. Returns the canonical YAML serialisation.
 */
export function ensureValidOpenAPI(raw: string, featureSlug: string): string {
  let body = raw.trim();
  // Strip ```yaml / ```yml / ``` fences.
  body = body.replace(/^```(?:ya?ml)?\s*\n/i, "").replace(/\n```\s*$/i, "");
  let doc: Record<string, unknown> | null = null;
  try {
    const loaded = yaml.load(body) as unknown;
    if (loaded && typeof loaded === "object") doc = loaded as Record<string, unknown>;
  } catch {
    doc = null;
  }
  if (!doc || typeof doc.openapi !== "string" || !doc.info) {
    // Fall back to a stub so the contract artifact always lints clean.
    doc = {
      openapi: "3.1.0",
      info: { title: featureSlug, version: "0.1.0" },
      paths: {
        "/health": {
          get: {
            summary: "Liveness probe",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
  } else if (typeof doc.openapi === "string" && !doc.openapi.startsWith("3.1")) {
    doc.openapi = "3.1.0";
  }
  return yaml.dump(doc, { lineWidth: 100 });
}
