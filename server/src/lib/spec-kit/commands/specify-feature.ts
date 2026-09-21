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
import { createFeature, resolveFeatureBySlug, type SpecKitFeatureDto } from "../features.js";
import { writeFeatureArtifact, type FeatureArtifactDto } from "../feature-artifacts.js";
import { runSpecKitAgent, loadProjectContext, type RunDeps } from "./runner.js";
import { SpecKitArtifactError } from "../artifacts.js";

const SYSTEM_PROMPT = [
  "You are a Business Analyst producing a Spec Kit-compatible spec.md.",
  "",
  "Output Markdown ONLY (no JSON wrapper). The document MUST contain the",
  "following sections in this exact order:",
  "",
  "  1. `# Spec` — one-paragraph summary of the goal.",
  "  2. `## Stakeholders` — bullet list of personas affected.",
  "  3. `## In scope` — bullet list of features included.",
  "  4. `## Out of scope` — bullet list of explicit exclusions.",
  "  5. `## Acceptance criteria` — Given/When/Then bullets, one per AC.",
  "  6. `## Non-functional requirements` — bullets with measurable thresholds.",
  "",
  "Be concise. Avoid implementation detail.",
].join("\n");

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
  // Title heuristic: first sentence of the prompt, capped at 80 chars.
  const title = trimmed.split(/[.\n]/)[0]!.trim().slice(0, 80);
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

  const run = await runSpecKitAgent({
    command: "specify",
    project,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: input.deps,
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
    message: `Generated spec.md (v${artifact.version}) for ${feature.slug} in ${run.tokensUsed} tokens.`,
    tokensUsed: run.tokensUsed,
  };
}
