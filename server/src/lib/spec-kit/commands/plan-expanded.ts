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
import { runSpecKitAgent, loadProjectContext, type RunDeps } from "./runner.js";
import { SpecKitArtifactError } from "../artifacts.js";

const PLAN_SYSTEM_PROMPT = [
  "You are a Solution Architect producing a Spec Kit-compatible plan.md.",
  "",
  "Output Markdown ONLY. The document MUST contain in order:",
  "",
  "  1. `# Plan` — paragraph summary of the technical approach.",
  "  2. `## Components` — bullets of named components and their responsibility.",
  "  3. `## Architecture diagram` — ONE Mermaid `graph` block (required).",
  "  4. `## Sequence diagrams` — zero or more Mermaid `sequenceDiagram` blocks.",
  "  5. `## ADRs` — bulleted Architecture Decision Records (Decision / Rationale).",
  "  6. `## Risks & mitigations` — bullets pairing each risk with its mitigation.",
  "  7. `## Constitution Compliance Check` — table of constitutional principles vs pass/fail/n/a.",
  "",
  "Cite spec.md acceptance criteria by section name.",
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

  // Phase 0 — research.md (always emitted).
  const research = await runSpecKitAgent({
    command: "plan",
    project,
    systemPrompt: RESEARCH_SYSTEM_PROMPT,
    userPrompt: `${userBase}\n\nProduce research.md per the system instructions.`,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: input.deps,
  });
  totalTokens += research.tokensUsed;
  const noClarMarkers = !/\[NEEDS CLARIFICATION\]/.test(spec.content);
  let researchContent = research.content;
  if (noClarMarkers && !/^##\s+Resolved Unknowns/m.test(researchContent)) {
    researchContent = `${researchContent.trim()}\n\n## Resolved Unknowns: none\n`;
  }
  artifacts.push(
    await writeFeatureArtifact({
      featureId: feature.id,
      key: "research.md",
      content: researchContent,
      actorId: input.actorId ?? null,
    }),
  );

  // Phase 1 — data-model.md
  const dataModel = await runSpecKitAgent({
    command: "plan",
    project,
    systemPrompt: DATA_MODEL_SYSTEM_PROMPT,
    userPrompt: `${userBase}\n\nProduce data-model.md per the system instructions.`,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: input.deps,
  });
  totalTokens += dataModel.tokensUsed;
  artifacts.push(
    await writeFeatureArtifact({
      featureId: feature.id,
      key: "data-model.md",
      content: dataModel.content,
      actorId: input.actorId ?? null,
    }),
  );

  // Phase 1 — contracts/api.openapi.yaml
  const contract = await runSpecKitAgent({
    command: "plan",
    project,
    systemPrompt: CONTRACT_SYSTEM_PROMPT,
    userPrompt: `${userBase}\n\nProduce the OpenAPI 3.1 contract per the system instructions.`,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: input.deps,
  });
  totalTokens += contract.tokensUsed;
  const contractBody = ensureValidOpenAPI(contract.content, feature.slug);
  artifacts.push(
    await writeFeatureArtifact({
      featureId: feature.id,
      key: "contracts/api.openapi.yaml",
      content: contractBody,
      actorId: input.actorId ?? null,
    }),
  );

  // Phase 1 — quickstart.md
  const quickstart = await runSpecKitAgent({
    command: "plan",
    project,
    systemPrompt: QUICKSTART_SYSTEM_PROMPT,
    userPrompt: `${userBase}\n\nProduce quickstart.md per the system instructions.`,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: input.deps,
  });
  totalTokens += quickstart.tokensUsed;
  artifacts.push(
    await writeFeatureArtifact({
      featureId: feature.id,
      key: "quickstart.md",
      content: quickstart.content,
      actorId: input.actorId ?? null,
    }),
  );

  // Plan.md (last — references the others).
  const plan = await runSpecKitAgent({
    command: "plan",
    project,
    systemPrompt: PLAN_SYSTEM_PROMPT,
    userPrompt: `${userBase}\n\nProduce plan.md per the system instructions.`,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: input.deps,
  });
  totalTokens += plan.tokensUsed;
  let planContent = plan.content;
  if (!/^##\s+Constitution Compliance Check/m.test(planContent)) {
    planContent = `${planContent.trim()}\n\n## Constitution Compliance Check\n\n| Principle | Status | Notes |\n| --- | --- | --- |\n| (auto-generated) | n/a | populate per principle from .specify/memory/constitution.md |\n`;
  }
  artifacts.push(
    await writeFeatureArtifact({
      featureId: feature.id,
      key: "plan.md",
      content: planContent,
      actorId: input.actorId ?? null,
    }),
  );

  await updateFeatureStatus(feature.id, "planned", input.actorId ?? null);

  return {
    artifacts,
    message: `Generated 5 plan artifacts for ${feature.slug} (${totalTokens} tokens).`,
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
