/**
 * Draft generator — Phase 9 (#67).
 *
 * Maps a completed Analysis (and its Requirements) into IssueDraft rows
 * persisted in Prisma. The generator produces:
 *
 *   - one master Epic draft summarising the analysis (always)
 *   - one draft per Requirement, optionally linked to the master epic via
 *     `parentDraftId`
 *   - story points (Fibonacci) inferred from priority + evidence count
 *   - acceptance criteria rendered as Given/When/Then bullets
 *   - Mermaid diagram for epics (component overview)
 *   - traceability footer pointing back at the analysis & source ids
 *
 * Drafts are upserted by `dedupHash` so re-running the generator does NOT
 * create duplicates — instead the body/labels are refreshed.
 */
import {
  findingSupportPanelSchema,
  parseAcceptanceCriteria,
  renderPublishedConfidenceNote,
  summarizeSupportPanels,
  type FindingSupportPanel,
  type RequirementSupportConfidence,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { computeDedupHash } from "./dedup.js";
import { PublishError } from "./types.js";
import { findTemplate } from "./template-service.js";
import { renderToMarkdown, buildTemplatePrompt } from "./template-renderer.js";
import { validateTemplateData } from "./template-validator.js";
import type { TemplateSchema } from "./template-schema.js";

const log = createChildLogger("draft-generator");

const FIBONACCI_POINTS = [1, 2, 3, 5, 8, 13];

export interface GenerateDraftsOptions {
  projectId: string;
  analysisId: string;
  /** Override target before persisting drafts so dedup hashes match the publish. */
  targetOwner: string;
  targetRepo: string;
  defaultLabels?: string[];
}

export interface GeneratedDraftSummary {
  total: number;
  epics: number;
  features: number;
  upserted: number;
  refreshed: number;
}

export async function generateDrafts(opts: GenerateDraftsOptions): Promise<GeneratedDraftSummary> {
  const project = await prisma.project.findFirst({
    where: { id: opts.projectId, deletedAt: null },
  });
  if (!project) {
    throw new PublishError(404, "PROJECT_NOT_FOUND", `project not found: ${opts.projectId}`);
  }
  const analysis = await prisma.analysis.findFirst({
    where: { id: opts.analysisId, projectId: opts.projectId, deletedAt: null },
  });
  if (!analysis) {
    throw new PublishError(404, "ANALYSIS_NOT_FOUND", `analysis not found: ${opts.analysisId}`);
  }
  const requirements = await prisma.requirement.findMany({
    where: { analysisId: opts.analysisId, deletedAt: null },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  if (requirements.length === 0) {
    throw new PublishError(
      400,
      "NO_REQUIREMENTS",
      "analysis has no requirements — run analysis first",
    );
  }

  const summary: GeneratedDraftSummary = {
    total: 0,
    epics: 0,
    features: 0,
    upserted: 0,
    refreshed: 0,
  };

  // ----- Epic draft -----
  const epicTitle = `[Epic] ${project.name} — Analysis ${analysis.id.slice(0, 8)}`;
  const epicHash = computeDedupHash(opts.targetOwner, opts.targetRepo, epicTitle);
  const epicBody = renderEpicBody({ project, analysis, requirements });
  const epicLabels = uniq([
    "epic",
    "metis-generated",
    `priority:${highestPriority(requirements)}`,
    ...(opts.defaultLabels ?? []),
  ]);
  const epic = await upsertDraft({
    projectId: opts.projectId,
    requirementId: null,
    parentDraftId: null,
    draftType: "epic",
    title: epicTitle,
    body: epicBody,
    labels: epicLabels,
    storyPoints: estimateStoryPoints({ priority: "high", evidenceCount: requirements.length }),
    dedupHash: epicHash,
    metadata: {
      analysisId: opts.analysisId,
      requirementIds: requirements.map((r) => r.id),
      generator: "draft-generator/v1",
    },
  });
  summary.total += 1;
  summary.epics += 1;
  if (epic.created) summary.upserted += 1;
  else summary.refreshed += 1;

  // Epic #1107 (#1110) — the panel's confidence for each requirement, so a
  // low-confidence one publishes its caution rather than losing the signal at
  // the GitHub boundary. One query for the whole batch; empty on flag-off runs.
  const confidenceByRequirement = await loadSupportConfidence(requirements);

  // ----- Feature drafts -----
  for (const req of requirements) {
    const reqTitle = `[${capitalize(req.type)}] ${req.title}`;
    const reqHash = computeDedupHash(opts.targetOwner, opts.targetRepo, reqTitle);
    const draftType = mapReqTypeToDraftType(req.type);
    const labels = uniq([
      draftType,
      "metis-generated",
      `priority:${req.priority}`,
      ...parseLabels(req.labels),
      ...(opts.defaultLabels ?? []),
    ]);
    const body = renderFeatureBody({
      project,
      analysis,
      requirement: req,
      parentTitle: epicTitle,
      supportConfidence: confidenceByRequirement.get(req.id) ?? null,
    });
    const draft = await upsertDraft({
      projectId: opts.projectId,
      requirementId: req.id,
      parentDraftId: epic.id,
      draftType,
      title: reqTitle,
      body,
      labels,
      storyPoints:
        req.storyPoints ??
        estimateStoryPoints({
          priority: req.priority,
          evidenceCount: parseLabels(req.labels).length,
        }),
      dedupHash: reqHash,
      metadata: {
        requirementId: req.id,
        analysisId: opts.analysisId,
        type: req.type,
      },
    });
    summary.total += 1;
    summary.features += 1;
    if (draft.created) summary.upserted += 1;
    else summary.refreshed += 1;
  }

  log.info("draft generation complete", {
    projectId: opts.projectId,
    analysisId: opts.analysisId,
    ...summary,
  });
  return summary;
}

interface UpsertArgs {
  projectId: string;
  requirementId: string | null;
  parentDraftId: string | null;
  draftType: "epic" | "feature" | "bug" | "task";
  title: string;
  body: string;
  labels: string[];
  storyPoints: number;
  dedupHash: string;
  metadata: Record<string, unknown>;
}

async function upsertDraft(args: UpsertArgs): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.issueDraft.findFirst({
    where: { projectId: args.projectId, dedupHash: args.dedupHash, deletedAt: null },
  });
  if (existing) {
    await prisma.issueDraft.update({
      where: { id: existing.id },
      data: {
        title: args.title,
        body: args.body,
        labels: JSON.stringify(args.labels),
        storyPoints: args.storyPoints,
        parentDraftId: args.parentDraftId,
        draftType: args.draftType,
        metadata: JSON.stringify(args.metadata),
        // Reset failure state on regeneration; preserve approved/published statuses.
        status:
          existing.status === "failed" || existing.status === "draft" ? "draft" : existing.status,
      },
    });
    return { id: existing.id, created: false };
  }
  const created = await prisma.issueDraft.create({
    data: {
      projectId: args.projectId,
      requirementId: args.requirementId,
      parentDraftId: args.parentDraftId,
      draftType: args.draftType,
      title: args.title,
      body: args.body,
      labels: JSON.stringify(args.labels),
      assignees: "[]",
      storyPoints: args.storyPoints,
      status: "draft",
      dedupHash: args.dedupHash,
      metadata: JSON.stringify(args.metadata),
    },
  });
  return { id: created.id, created: true };
}

// ---- Body renderers --------------------------------------------------------

function renderEpicBody(input: {
  project: { id: string; name: string };
  analysis: { id: string };
  requirements: Array<{ id: string; title: string; type: string; priority: string }>;
}): string {
  const { project, analysis, requirements } = input;
  const counts = countByPriority(requirements);
  const lines = [
    `## Goal`,
    ``,
    `Track the requirements identified by METIS analysis ` +
      `\`${analysis.id.slice(0, 8)}\` for project **${project.name}**.`,
    ``,
    `## Scope`,
    ``,
    `**Total requirements**: ${requirements.length}`,
    ``,
    `| Priority | Count |`,
    `| -------- | ----- |`,
    ...(["critical", "high", "medium", "low"] as const).map((p) => `| ${p} | ${counts[p] ?? 0} |`),
    ``,
    `## Architecture overview`,
    ``,
    "```mermaid",
    "flowchart LR",
    "  Analysis[Analysis] --> Epic[Epic]",
    "  Epic --> Requirements[Requirements]",
    "  Requirements --> GitHub[(GitHub Issues)]",
    "```",
    ``,
    `## Sub-issues`,
    ``,
    // #1096 — the full requirement id. cuid2 ids minted in the same millisecond
    // share a long prefix, so the previous 8-char truncation rendered every
    // sub-issue in the list with an identical, useless "identifier".
    ...requirements.map(
      (r, i) => `${i + 1}. [ ] ${r.title} _(${r.type}, ${r.priority})_ — \`${r.id}\``,
    ),
    ``,
    `## Acceptance criteria`,
    ``,
    `- [ ] Every sub-issue is closed via merged PR`,
    `- [ ] CI green and coverage gate met on all touched workspaces`,
    `- [ ] No new high/critical security findings`,
    ``,
    `---`,
    `> Generated by METIS · project=\`${project.id.slice(0, 8)}\` · analysis=\`${analysis.id.slice(0, 8)}\``,
  ];
  return lines.join("\n");
}

function renderFeatureBody(input: {
  project: { id: string; name: string };
  analysis: { id: string };
  requirement: {
    id: string;
    title: string;
    body: string;
    type: string;
    priority: string;
    /** #1096 — persisted JSON array of the requirement's own criteria. */
    acceptanceCriteria?: string;
  };
  parentTitle: string;
  /**
   * Epic #1107 (#1110) — the panel's rolled-up confidence for this requirement.
   * Only `low` and `no-signal` render anything; everything else (and `null`,
   * which is every flag-off run) produces a byte-identical body to pre-#1110.
   */
  supportConfidence?: RequirementSupportConfidence | null;
}): string {
  const { project, analysis, requirement, parentTitle } = input;
  const acceptance = renderAcceptanceCriteria({
    body: requirement.body,
    acceptanceCriteria: parseAcceptanceCriteria(requirement.acceptanceCriteria),
  });
  // #1110 — placed directly under the description and ABOVE the acceptance
  // criteria: a caution a developer reads after the criteria they already
  // started working from is a caution that arrived too late.
  const confidenceNote = renderPublishedConfidenceNote(input.supportConfidence);
  const lines = [
    `> Parent epic: **${parentTitle}**`,
    ``,
    `## Description`,
    ``,
    requirement.body || "_No description provided._",
    ``,
    ...(confidenceNote ? [confidenceNote, ``] : []),
    `## Acceptance criteria`,
    ``,
    acceptance,
    ``,
    `## Definition of done`,
    ``,
    `- [ ] Code implemented and self-reviewed`,
    `- [ ] Tests added and passing at the workspace coverage gate`,
    `- [ ] Lint clean`,
    `- [ ] PR opened with \`Closes #<this issue>\``,
    ``,
    `---`,
    // #1096 — the requirement id is the traceability spine back to METIS and must
    // be resolvable; a shared 8-char cuid2 prefix is not.
    `> Generated by METIS · project=\`${project.id.slice(0, 8)}\` · analysis=\`${analysis.id.slice(0, 8)}\` · requirement=\`${requirement.id}\``,
  ];
  return lines.join("\n");
}

/**
 * Issue #1096 — render the requirement's OWN acceptance criteria.
 *
 * This function used to emit a fixed three-line Given/When/Then block whenever
 * the body was not already Gherkin — the same three lines on every issue METIS
 * published. That is worse than omitting the section: it renders as a filled-in
 * criteria list, so a developer receiving the issue believes criteria were
 * authored. The criteria are now persisted structured data (`Requirement.
 * acceptanceCriteria`), and when there are none we say so in words that cannot
 * be mistaken for a real criterion.
 */
export const NO_ACCEPTANCE_CRITERIA_NOTE =
  "_No acceptance criteria were derived from the analysis evidence — add them before implementation._";

function renderAcceptanceCriteria(req: { body: string; acceptanceCriteria?: string[] }): string {
  const criteria = (req.acceptanceCriteria ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
  if (criteria.length > 0) {
    return criteria.map((c) => `- [ ] ${c}`).join("\n");
  }

  // Legacy fallback: a body the analysis already wrote as Gherkin is itself the
  // requirement's text, so bulleting it invents nothing.
  const trimmed = req.body.trim();
  if (/given\b.*when\b.*then\b/is.test(trimmed)) {
    return trimmed
      .split(/\n+/)
      .filter((line) => line.trim().length > 0)
      .map((line) => `- [ ] ${line.trim()}`)
      .join("\n");
  }

  return NO_ACCEPTANCE_CRITERIA_NOTE;
}

/**
 * Epic #1107 (#1110) — resolve each requirement's panel confidence from the
 * findings it was synthesised from.
 *
 * The requirement→finding spine is the `finding:<id>` labels `persistRequirements`
 * writes, and the panel rides the `Finding.evidence` JSON blob (#1109's
 * no-migration route). One batched query for the whole draft run; a run where no
 * requirement links a finding, or where the panel never ran, issues no query at
 * all and yields an empty map — so a flag-off publish does exactly what it did
 * before #1110.
 */
async function loadSupportConfidence(
  requirements: ReadonlyArray<{ id: string; labels: string }>,
): Promise<Map<string, RequirementSupportConfidence>> {
  const findingIdsByRequirement = new Map<string, string[]>();
  const allIds = new Set<string>();
  for (const r of requirements) {
    const ids = parseLabels(r.labels)
      .filter((l) => l.startsWith("finding:"))
      .map((l) => l.slice("finding:".length));
    if (ids.length === 0) continue;
    findingIdsByRequirement.set(r.id, ids);
    for (const id of ids) allIds.add(id);
  }
  const out = new Map<string, RequirementSupportConfidence>();
  if (allIds.size === 0) return out;

  const rows = await prisma.finding.findMany({
    where: { id: { in: [...allIds] } },
    select: { id: true, title: true, evidence: true },
  });
  const byId = new Map(
    rows.map((f) => [f.id, { title: f.title, supportPanel: parseSupportPanel(f.evidence) }]),
  );
  for (const [requirementId, ids] of findingIdsByRequirement) {
    const rollup = summarizeSupportPanels(
      ids.map((id) => byId.get(id)).filter((f): f is NonNullable<typeof f> => Boolean(f)),
    );
    if (rollup) out.set(requirementId, rollup);
  }
  return out;
}

/**
 * Pull the panel out of a persisted `Finding.evidence` blob, validating on the
 * way. Anything that does not parse reads as "no panel ran" — the same neutral
 * state as a pre-#1109 row — so a malformed blob can never publish a caution
 * built from half-formed data.
 */
function parseSupportPanel(evidence: string | null): FindingSupportPanel | null {
  if (!evidence) return null;
  try {
    const blob = JSON.parse(evidence) as { supportPanel?: unknown };
    if (!blob.supportPanel) return null;
    const parsed = findingSupportPanelSchema.safeParse(blob.supportPanel);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---- Helpers ---------------------------------------------------------------

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr.filter((s) => s.length > 0)));
}

function parseLabels(json: string): string[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignore */
  }
  return [];
}

function countByPriority(requirements: Array<{ priority: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of requirements) out[r.priority] = (out[r.priority] ?? 0) + 1;
  return out;
}

function highestPriority(requirements: Array<{ priority: string }>): string {
  const order = ["critical", "high", "medium", "low"];
  for (const p of order) if (requirements.some((r) => r.priority === p)) return p;
  return "medium";
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function mapReqTypeToDraftType(type: string): "epic" | "feature" | "bug" | "task" {
  switch (type) {
    case "epic":
      return "epic";
    case "bug":
      return "bug";
    case "chore":
    case "task":
      return "task";
    default:
      return "feature";
  }
}

export function estimateStoryPoints(input: { priority: string; evidenceCount: number }): number {
  const base = input.priority === "critical" ? 5 : input.priority === "high" ? 3 : 2;
  const bump = Math.min(Math.floor(input.evidenceCount / 3), 3);
  const target = base + bump;
  // Snap to closest Fibonacci point.
  let chosen = FIBONACCI_POINTS[0];
  let bestDiff = Math.abs(target - chosen);
  for (const f of FIBONACCI_POINTS) {
    const diff = Math.abs(target - f);
    if (diff < bestDiff) {
      chosen = f;
      bestDiff = diff;
    }
  }
  return chosen;
}

// ---- Template-aware rendering (Epic #595 / #613) ---------------------------

/**
 * Load the template for a project + issue type combo, render to markdown if
 * template data is provided, and validate. Falls back to null when no template
 * exists (backwards compatible — callers use the legacy renderer).
 */
export async function loadProjectTemplate(
  projectId: string,
  platform: string,
  templateType: string,
): Promise<TemplateSchema | null> {
  const row = await findTemplate(projectId, platform, templateType);
  if (!row) return null;
  try {
    return JSON.parse(row.schema) as TemplateSchema;
  } catch {
    log.warn("failed to parse template schema", { templateId: row.id });
    return null;
  }
}

/**
 * Render template data to a markdown issue body using the template schema.
 * Validates the data first; returns null if validation fails.
 */
export function renderWithTemplate(
  data: Record<string, unknown>,
  schema: TemplateSchema,
): { body: string; valid: boolean; errors: string[] } {
  const result = validateTemplateData(data, schema);
  if (!result.valid) {
    return { body: "", valid: false, errors: result.errors };
  }
  return { body: renderToMarkdown(data, schema), valid: true, errors: [] };
}

/**
 * Build a prompt fragment that instructs the LLM to produce structured
 * output conforming to the template schema.
 */
export { buildTemplatePrompt };

export const __testing = {
  uniq,
  highestPriority,
  estimateStoryPoints,
  parseLabels,
  mapReqTypeToDraftType,
  renderAcceptanceCriteria,
  // #1096 — body renderers exercised directly so the acceptance-criteria and
  // sub-issue-id behaviour is testable without a database.
  renderFeatureBody,
  renderEpicBody,
  // Epic #1107 (#1110) — the requirement→finding→panel resolution, exercised
  // against a stubbed prisma so the rollup that decides what gets published is
  // tested without standing up the whole draft-generation path.
  loadSupportConfidence,
  parseSupportPanel,
};
