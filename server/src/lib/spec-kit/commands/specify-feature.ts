/**
 * Epic #396 (MVP-5) — feature-scoped `/speckit.specify`.
 *
 * Wraps the v1.2 BA-prompt agent runner but writes the resulting `spec.md`
 * into the per-feature artifact set under a newly-created `Feature` row.
 * Optionally creates a Git branch named `NNN-kebab-name` when
 * `SPECKIT_AUTOBRANCH=true`.
 *
 * Slug source precedence:
 *   1. `featureSlugOverride` request option (request-scoped — no global
 *      `process.env.SPECIFY_FEATURE` read, which would cross-contaminate
 *      tenants in a multi-project server).
 *   2. Auto-allocated `NNN-kebab(title)`.
 */
import {
  createFeature,
  resolveFeatureBySlug,
  truncateAtWord,
  type SpecKitFeatureDto,
} from "../features.js";
import { writeFeatureArtifact, type FeatureArtifactDto } from "../feature-artifacts.js";
import { runSpecKitAgent, loadProjectContext, truncationWarning, type RunDeps } from "./runner.js";
import { SpecKitArtifactError } from "../artifacts.js";
import {
  buildSpecKitRagContext,
  type CallerLookup,
  type SiblingSymbolLookup,
  type SpecKitFusedCodeDeps,
  type SpecKitKnowledgeService,
} from "../rag-context.js";
import { describeGrounding, PINNED_REQUIREMENT_DOCUMENTS } from "../grounding.js";
import { SPECIFY_SYSTEM_PROMPT } from "./prompts.js";

/**
 * #786 — the same contract as `/specify`: stable `AC-n` ids (which
 * `speckit.tasks` maps every task to), what/why only, and scope reconciled
 * against the retrieved requirements.
 */
const SYSTEM_PROMPT = SPECIFY_SYSTEM_PROMPT;

export interface SpecifyFeatureInput {
  projectId: string;
  prompt: string;
  /** Per-request slug override. Request-scoped — NEVER read from process.env. */
  featureSlugOverride?: string;
  /** Optional Git branch creator (mockable for tests). */
  branchClient?: GitBranchClient;
  actorId?: string | null;
  sessionId?: string | null;
  deps?: RunDeps;
  /** #786 — injectable knowledge service for RAG grounding. Defaults to the real one. */
  knowledgeService?: SpecKitKnowledgeService;
  /** #944 — injectable code-graph retrieval. Defaults to the production wiring. */
  fusedCode?: SpecKitFusedCodeDeps;
  /** #944 — injectable same-file sibling lookup. Defaults to the production wiring. */
  siblingLookup?: SiblingSymbolLookup;
  /** #944 — injectable caller lookup. Defaults to the production wiring. */
  callerLookup?: CallerLookup;
}

export interface SpecifyFeatureResult {
  feature: SpecKitFeatureDto;
  artifact: FeatureArtifactDto;
  message: string;
  tokensUsed: number;
}

export interface GitBranchClient {
  createBranch(projectId: string, branchName: string): Promise<void>;
}

export async function runSpecifyFeature(input: SpecifyFeatureInput): Promise<SpecifyFeatureResult> {
  const trimmed = (input.prompt ?? "").trim();
  if (trimmed.length === 0) {
    throw new SpecKitArtifactError(
      400,
      "SPECKIT_EMPTY_INPUT",
      "/speckit.specify requires a description after the command word",
    );
  }

  const project = await loadProjectContext(input.projectId);
  // Title heuristic: first sentence of the prompt, capped at 80 chars on a word
  // boundary (#786: `…let a user mark eve` became the slug's last word).
  const title = truncateAtWord(trimmed.split(/[.\n]/)[0]!, 80);
  const slug = input.featureSlugOverride;

  let feature: SpecKitFeatureDto;
  if (slug) {
    const existing = await resolveFeatureBySlug(input.projectId, slug);
    feature =
      existing ??
      (await createFeature({
        projectId: input.projectId,
        title,
        forcedSlug: slug,
        actorId: input.actorId ?? null,
      }));
  } else {
    feature = await createFeature({
      projectId: input.projectId,
      title,
      actorId: input.actorId ?? null,
    });
  }

  const userPrompt = [
    `Project: ${project.name}`,
    project.description ? `Description: ${project.description}` : "",
    "",
    `Feature: ${feature.slug} — ${feature.title}`,
    "",
    "Brief from operator:",
    trimmed,
  ]
    .filter(Boolean)
    .join("\n");

  // #786 — ground the spec exactly as `/specify` does (#374 / #20): retrieve on
  // the brief alone and pin the top requirements documents whole. Empty or
  // failed retrieval ⇒ "" (ungrounded); never throws.
  const rag = await buildSpecKitRagContext(input.projectId, trimmed, {
    knowledgeService: input.knowledgeService,
    // #944 — a spec must see the capability that already ships, and who calls
    // it: grounded on documents alone, a walkthrough spec never mentioned the
    // existing function that did most of the job, or its caller.
    fusedCode: input.fusedCode,
    includeCode: true,
    expandDocuments: PINNED_REQUIREMENT_DOCUMENTS,
    siblings: { ...(input.siblingLookup ? { lookup: input.siblingLookup } : {}) },
    callers: { ...(input.callerLookup ? { lookup: input.callerLookup } : {}) },
  });

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

  const artifact = await writeFeatureArtifact({
    featureId: feature.id,
    key: "spec.md",
    content: run.content,
    actorId: input.actorId ?? null,
  });

  // Optional auto-branch — best-effort, never blocks the spec write.
  if (process.env.SPECKIT_AUTOBRANCH === "true" && input.branchClient) {
    try {
      await input.branchClient.createBranch(input.projectId, feature.slug);
    } catch {
      // best-effort
    }
  }

  return {
    feature,
    artifact,
    message: `Generated spec.md (v${artifact.version}) for ${feature.slug} in ${run.tokensUsed} tokens — ${describeGrounding(rag)}.${truncationWarning(run.truncated ? ["spec.md"] : [])}`,
    tokensUsed: run.tokensUsed,
  };
}
