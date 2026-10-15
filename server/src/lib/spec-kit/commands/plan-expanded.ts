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
 *
 * #1065 — plan.md is generated FIRST and handed to the data model, the
 * contract and the quickstart, so they follow the plan instead of guessing at
 * it (run 7: a contract endpoint the plan had put out of scope). Nothing is
 * written until every artifact has been generated AND passed the store's own
 * checks, so a failed model call or an oversized artifact leaves the previous
 * set whole rather than a mix of old and new. The five writes are not one
 * database transaction: a database error part-way can still leave a mixed set.
 */
import yaml from "js-yaml";
import {
  assertFeatureArtifactWritable,
  writeFeatureArtifact,
  getFeatureArtifact,
  type FeatureArtifactDto,
} from "../feature-artifacts.js";
import { resolveFeatureBySlug, updateFeatureStatus } from "../features.js";
import { requireGate, GateUnmetError } from "../gates.js";
import { loadAsPreamble } from "../constitution-meta.js";
import {
  runSpecKitAgent,
  loadProjectContext,
  keepsPriorVersion,
  truncationWarning,
  type RunDeps,
} from "./runner.js";
import { SpecKitArtifactError } from "../artifacts.js";
import { createChildLogger } from "../../logger.js";
import {
  findContractPlanContradictions,
  NO_REST_SURFACE_EXTENSION,
  NO_REST_SURFACE_MARKER,
  planHasNoRestSurfaceMarker,
} from "../contract-check.js";
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
  describeContextDropped,
  describeGrounding,
  extractRequirementText,
  PINNED_REQUIREMENT_DOCUMENTS,
  PLAN_CONTEXT_ARTIFACT,
  renderPlanContext,
  verifyPlanPaths,
  type PlanPathLookup,
} from "../grounding.js";
import type { PlanLocalisationSource } from "../plan-localisation.js";
import { SpecKitJobStopError, reportSpecKitJobPhase } from "../job-scope.js";
import { describePlanDesignDiff, diffPlanDesign, previousPlanSection } from "../plan-diff.js";
import {
  createDefaultSymbolFileLookup,
  describeNotVisibleClaims,
  describeParameterRenames,
  findNotVisibleClaims,
  findParameterRenames,
  type SymbolFileLookup,
} from "../plan-checks.js";

const log = createChildLogger("spec-kit-plan");

/** #1059 — the order the plan artifacts are generated in, for a job's phase text. */
const PLAN_ARTIFACT_ORDER = [
  "plan.md",
  "research.md",
  "data-model.md",
  "contracts/api.openapi.yaml",
  "quickstart.md",
];

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
  "(title + version) and `paths`.",
  "",
  "Define ONLY the path operations the plan puts in scope — the endpoints it adds",
  "or changes. Never invent an endpoint, and never add a placeholder such as",
  "`/health`. If the plan adds or changes no REST/HTTP endpoint, that is a valid",
  `result: emit \`paths: {}\` and \`${NO_REST_SURFACE_EXTENSION}: true\`, and say why in`,
  "`info.description`.",
].join("\n");

/**
 * #1065 — appended to the plan.md request, so the contract step can tell "no
 * endpoint" from "endpoints not listed" without guessing.
 */
const PLAN_REST_SURFACE_ASK = [
  "Under `## Components`, name every REST/HTTP endpoint this feature adds or",
  "changes as `METHOD /path`. If it adds or changes none, write exactly the line",
  `\`${NO_REST_SURFACE_MARKER}\` there instead.`,
].join(" ");

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
  /** #1060 — injectable code-graph source for the localisation. Defaults to the production wiring. */
  localisationSource?: PlanLocalisationSource;
  /** #1135 — injectable function → file lookup for the "not visible" check. */
  symbolFileLookup?: SymbolFileLookup;
}

export interface PlanResult {
  artifacts: FeatureArtifactDto[];
  message: string;
  tokensUsed: number;
  /** #1060 — every repository file the plan's context named; also stored as `plan-context.md`. */
  retrievedFiles: string[];
  /**
   * #1057 — cut-off replies by artifact key, set only for those NOT saved
   * because a complete version already existed (that version stays current).
   */
  partialContent?: Record<string, string>;
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
  // #1134 — a re-run revises the current plan instead of designing afresh, and
  // its result says what changed against it.
  const storedPlan = await getFeatureArtifact(feature.id, "plan.md");
  const previousPlan = storedPlan && storedPlan.content.trim().length > 0 ? storedPlan : null;

  // #786 — ground every artifact the way `/plan` is grounded (#375 / #20 /
  // #785): retrieve on the spec's own requirement text, always include code
  // symbols with their same-file siblings, and pin the top requirements
  // documents whole. One retrieval serves all five calls, and the block sits in
  // the cached system prefix right after the constitution. Empty or failed
  // retrieval ⇒ "" (ungrounded); never throws.
  reportSpecKitJobPhase("Retrieving project context for the plan", 5);
  const rag = await buildSpecKitRagContext(input.projectId, extractRequirementText(spec.content), {
    knowledgeService: input.knowledgeService,
    fusedCode: input.fusedCode,
    includeCode: true,
    expandDocuments: PINNED_REQUIREMENT_DOCUMENTS,
    siblings: { ...(input.siblingLookup ? { lookup: input.siblingLookup } : {}) },
    // #944 — and the code that already calls them: a plan missed the
    // protocol-adapter writers of the table it changed.
    callers: { ...(input.callerLookup ? { lookup: input.callerLookup } : {}) },
    // #1060 — and down the code graph to the data that code touches: the
    // migration, the table's writers, the query builder and the client struct
    // share no word with a spec, so similarity never retrieved them.
    localise: { ...(input.localisationSource ? { source: input.localisationSource } : {}) },
  });

  const userBase = [
    `Feature: ${feature.slug} — ${feature.title}`,
    "",
    "spec.md:",
    "```md",
    spec.content,
    "```",
  ].join("\n");

  let totalTokens = 0;
  // #944 — artifacts whose reply the output cap still cut off.
  const truncated: string[] = [];
  const generate = async (
    key: string,
    systemPrompt: string,
    ask: string,
    context = userBase,
  ): Promise<string> => {
    const format = key.endsWith(".yaml") ? ("yaml" as const) : ("markdown" as const);
    // #1059 — the five artifacts are the command's natural phases.
    const step = PLAN_ARTIFACT_ORDER.indexOf(key) + 1;
    const run = await runSpecKitAgent({
      phase: `Generating ${key} (${step} of ${PLAN_ARTIFACT_ORDER.length})`,
      phaseProgress: 10 + Math.round(((step - 1) / PLAN_ARTIFACT_ORDER.length) * 80),
      command: "plan",
      project,
      systemPrompt,
      userPrompt: `${context}\n\n${ask}`,
      actorId: input.actorId ?? null,
      sessionId: input.sessionId ?? null,
      deps: input.deps,
      ragContext: rag.context,
      ragChunksUsed: rag.usedChunks,
      format,
      // #1144 — all five calls carry this constitution + RAG prefix: the first
      // writes the cache at its end and the other four read it.
      cacheSharedPrefix: true,
    });
    totalTokens += run.tokensUsed;
    if (run.truncated) truncated.push(key);
    return run.content;
  };
  // #1057 — cut-off replies NOT saved because a complete version already
  // existed; that version stays current and the partial text is returned.
  const partialContent: Record<string, string> = {};
  // #1065 — nothing is written while another artifact can still fail to be
  // generated: each one is staged here and the set is written once all five
  // exist. A 502 from any model call (#1057) therefore leaves the previous set
  // whole. The write phase below is NOT a transaction — see the note there.
  const staged: Array<{ key: string; content: string; prior: FeatureArtifactDto | null }> = [];
  /** Stage an artifact; returns the content that will be current after this run. */
  const stage = async (key: string, content: string): Promise<string> => {
    const cut = truncated.includes(key);
    const stored = cut ? await getFeatureArtifact(feature.id, key) : null;
    const prior = stored && keepsPriorVersion(cut, stored) ? stored : null;
    if (prior) partialContent[key] = content;
    staged.push({ key, content, prior });
    return prior ? prior.content : content;
  };

  // plan.md first (#1065) — the data model, contract and quickstart follow it.
  let planContent = await generate(
    "plan.md",
    PLAN_SYSTEM_PROMPT,
    `Produce plan.md per the system instructions. ${PLAN_REST_SURFACE_ASK}`,
    previousPlan ? `${userBase}\n\n${previousPlanSection(previousPlan)}` : userBase,
  );
  if (!/^##\s+Constitution Compliance Check/m.test(planContent)) {
    planContent = `${planContent.trim()}\n\n## Constitution Compliance Check\n\n| Principle | Status | Notes |\n| --- | --- | --- |\n| (auto-generated) | n/a | populate per principle from .specify/memory/constitution.md |\n`;
  }
  // The plan the later artifacts must agree with is the one that stays current:
  // the complete earlier version when this reply was cut off (#1057).
  const currentPlan = await stage("plan.md", planContent);
  const withPlan = [
    userBase,
    "",
    "plan.md — the plan this document MUST agree with. Do not add scope it does not contain:",
    "```md",
    currentPlan,
    "```",
  ].join("\n");

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
  await stage("research.md", researchContent);

  // Phase 1 — data-model.md
  await stage(
    "data-model.md",
    await generate(
      "data-model.md",
      DATA_MODEL_SYSTEM_PROMPT,
      "Produce data-model.md per the system instructions. Model only the entities and fields the plan above adds or changes.",
      withPlan,
    ),
  );

  // Phase 1 — contracts/api.openapi.yaml. A plan that declares no REST surface
  // gets the explicit empty contract without a model call: there is nothing to
  // derive, and a model asked for a contract tends to supply an endpoint.
  const noRestSurface = planHasNoRestSurfaceMarker(currentPlan);
  const currentContract = await stage(
    "contracts/api.openapi.yaml",
    noRestSurface
      ? noRestSurfaceContract(feature.slug, `plan.md declares \`${NO_REST_SURFACE_MARKER}\`.`)
      : ensureValidOpenAPI(
          await generate(
            "contracts/api.openapi.yaml",
            CONTRACT_SYSTEM_PROMPT,
            "Produce the OpenAPI 3.1 contract per the system instructions, from the plan above.",
            withPlan,
          ),
          feature.slug,
        ),
  );

  // Phase 1 — quickstart.md
  await stage(
    "quickstart.md",
    await generate(
      "quickstart.md",
      QUICKSTART_SYSTEM_PROMPT,
      "Produce quickstart.md per the system instructions, for the change the plan above describes.",
      withPlan,
    ),
  );

  // Every artifact exists. Before the first write, run every check the store
  // makes ahead of its database calls (key shape, 200,000-character cap) on the
  // whole set, so a refusal that can be known in advance refuses all five.
  // What is left is a database error between two writes: the store has no
  // transaction, so that — and only that — can still leave a mixed set.
  for (const item of staged) {
    if (!item.prior) assertFeatureArtifactWritable(item.key, item.content);
  }
  reportSpecKitJobPhase("Saving the plan artifacts", 95);
  // #1060 — record what this plan was given, beside it. Only when this run's
  // plan.md is the one being saved: a kept earlier plan keeps its own record.
  // The record is not checked with the set above: it is written after it, and a
  // record that cannot be saved must not refuse a plan that can (see below).
  const recordsContext = !staged[0]!.prior;
  // Write the set. plan.md goes last so it is the artifact the page opens on,
  // as before.
  const artifacts: FeatureArtifactDto[] = [];
  for (const item of [...staged.slice(1), staged[0]!]) {
    artifacts.push(
      item.prior ??
        (await writeFeatureArtifact({
          featureId: feature.id,
          key: item.key,
          content: item.content,
          actorId: input.actorId ?? null,
        })),
    );
  }
  const plan = artifacts[artifacts.length - 1]!;

  // #1060 — the record goes AFTER plan.md, and names the version it describes
  // (#1094 review M4). The store has no transaction: written first, a failure
  // among the five left a new record beside the old plan.md, saying it
  // described "the current plan.md". Written last, a failure of this write
  // leaves the new plan.md beside the older record, which names the older
  // version and so cannot be mistaken for this plan's. It is not one of the
  // five generated artifacts the result returns, and losing it does not fail a
  // command whose plan is saved: the message says so instead.
  let contextRecorded = false;
  if (recordsContext) {
    try {
      await writeFeatureArtifact({
        featureId: feature.id,
        key: PLAN_CONTEXT_ARTIFACT,
        content: renderPlanContext(rag, { planVersion: plan.version }),
        actorId: input.actorId ?? null,
      });
      contextRecorded = true;
    } catch (err) {
      // A job that lost its row is stopped here like at any other write: that
      // is not "the record could not be saved", and the command must not go on.
      if (err instanceof SpecKitJobStopError) throw err;
      log.warn("plan-context.md could not be saved; the five plan artifacts were", {
        projectId: input.projectId,
        feature: feature.slug,
        error: (err as Error).message,
      });
    }
  }

  // #1057 — a cut-off plan.md does not make the feature `planned`.
  const planCut = truncated.includes("plan.md");
  if (!planCut) await updateFeatureStatus(feature.id, "planned", input.actorId ?? null);

  // #786 — the same post-generation path check as `/plan` (#20): an invented
  // path is reported, never trusted.
  const paths = await verifyPlanPaths(input.projectId, plan.content, input.pathLookup);
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

  // #1065 — a contract operation the plan does not account for is reported at
  // once, not left for `/speckit.analyze` to find.
  const contradictions = findContractPlanContradictions(
    [{ key: "contracts/api.openapi.yaml", content: currentContract }],
    currentPlan,
  );
  const contractNote =
    contradictions.length > 0
      ? ` Contract check: ${contradictions.join(" ")} Correct plan.md or the contract before /speckit.tasks.`
      : noRestSurface
        ? " The plan declares no REST surface, so the contract defines no endpoint."
        : "";

  // #1060 — the message says where the files the plan was given are recorded:
  // that record is how a reader checks a "not in the retrieved context" in the
  // plan. With no record to point at, the note carries its own detail.
  const contextNote = !recordsContext
    ? ""
    : contextRecorded
      ? ` The ${rag.files.length} file${rag.files.length === 1 ? "" : "s"} the plan was given ${rag.files.length === 1 ? "is" : "are"} recorded in \`${PLAN_CONTEXT_ARTIFACT}\`.${describeContextDropped(rag.dropped, PLAN_CONTEXT_ARTIFACT)}`
      : ` \`${PLAN_CONTEXT_ARTIFACT}\` (the record of the files this plan was given) could not be saved; an earlier one, if present, describes an earlier plan.md.${describeContextDropped(rag.dropped)}`;

  // #1135 — what the plan says it could not see, against what it was given, and
  // the names the spec states that it renamed without saying so.
  const checkNote =
    describeNotVisibleClaims(
      await findNotVisibleClaims(
        plan.content,
        rag,
        input.symbolFileLookup ?? createDefaultSymbolFileLookup(input.projectId),
      ),
      PLAN_CONTEXT_ARTIFACT,
    ) + describeParameterRenames(findParameterRenames(spec.content, plan.content));

  const kept = Object.keys(partialContent);
  const keptNote =
    kept.length > 0
      ? ` The complete previous ${kept.map((k) => `\`${k}\``).join(", ")} ${kept.length === 1 ? "is" : "are"} kept as current; the cut-off ${kept.length === 1 ? "reply was" : "replies were"} not saved and ${kept.length === 1 ? "is" : "are"} returned in \`partialContent\`.`
      : "";
  const statusNote = planCut ? " The feature was not marked planned." : "";
  // #1134 — only when this run's plan.md is the one saved: a kept plan did not change.
  const designNote =
    previousPlan && plan.version !== previousPlan.version
      ? describePlanDesignDiff(
          previousPlan.version,
          diffPlanDesign(previousPlan.content, plan.content),
        )
      : "";

  return {
    artifacts,
    message: `Generated 5 plan artifacts for ${feature.slug} (${totalTokens} tokens) — ${describeGrounding(rag)}.${designNote}${contextNote}${pathNote}${noneNote}${mermaidNote}${contractNote}${checkNote}${truncationWarning(truncated)}${keptNote}${statusNote}`,
    tokensUsed: totalTokens,
    retrievedFiles: rag.files,
    ...(kept.length > 0 ? { partialContent } : {}),
  };
}

/**
 * #1065 — the contract of a feature with no REST surface: valid OpenAPI 3.1
 * with no path at all, marked so a reader (and `/speckit.analyze`) can tell an
 * intended empty contract from a missing one.
 */
export function noRestSurfaceContract(featureSlug: string, reason: string): string {
  return yaml.dump(
    {
      openapi: "3.1.0",
      info: {
        title: featureSlug,
        version: "0.1.0",
        description: `This feature adds or changes no REST endpoint. ${reason}`,
      },
      paths: {},
      [NO_REST_SURFACE_EXTENSION]: true,
    },
    { lineWidth: 100 },
  );
}

/**
 * Ensure the model output is a valid OpenAPI 3.1 YAML. Strips markdown
 * fences, parses with js-yaml, and ensures the document has the required
 * top-level keys. Returns the canonical YAML serialisation.
 *
 * #1065 — a contract with no path is accepted as it is, and a reply that is
 * not OpenAPI becomes a contract with no path: it used to become a `/health`
 * stub, an endpoint nobody had planned.
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
    // Still lints clean, and declares nothing the model did not write.
    return yaml.dump(
      {
        openapi: "3.1.0",
        info: {
          title: featureSlug,
          version: "0.1.0",
          description:
            "The model's reply was not a valid OpenAPI document, so no endpoint is declared. Re-run /speckit.plan.",
        },
        paths: {},
      },
      { lineWidth: 100 },
    );
  }
  if (!doc.openapi.startsWith("3.1")) doc.openapi = "3.1.0";
  if (!doc.paths || typeof doc.paths !== "object") doc.paths = {};
  return yaml.dump(doc, { lineWidth: 100 });
}
