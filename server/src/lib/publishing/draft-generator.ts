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
import crypto from "node:crypto";
import {
  DRAFT_SELECTION_THRESHOLD,
  findingSupportPanelSchema,
  type DraftCandidates,
  parseAcceptanceCriteria,
  isAcceptanceCriteriaCleared,
  deriveBodyAcceptanceCriteria,
  extractBodyAcceptanceCriteria as extractCriteriaFromBody,
  renderPublishedConfidenceNote,
  summarizeSupportPanels,
  type FindingSupportPanel,
  type RequirementSupportConfidence,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { isUniqueViolation } from "../db/prisma-errors.js";
import { createChildLogger } from "../logger.js";
import { computeDedupHash } from "./dedup.js";
import { publishableLabels } from "./label-sync.js";
import { buildEpicTitle } from "./epic-title.js";
import { canCreateTickets } from "../analysis/approval-checkpoint.js";
import {
  promoteApprovedRequirements,
  type PromotionOutcome,
} from "../analysis/promote-requirements.js";
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
  /** #863 — draft only these requirements of the analysis (all when omitted). */
  requirementIds?: string[];
}

export interface GeneratedDraftSummary {
  total: number;
  epics: number;
  features: number;
  upserted: number;
  refreshed: number;
}

/**
 * Issue #362 — an analysis with no requirements is usually not un-run: the
 * approval gate (#1104) withholds its synthesized requirements until every
 * approval checkpoint is resolved. Name that precondition, with its counts and
 * where to resolve it, instead of telling the user to re-run the analysis.
 */
async function noRequirementsError(
  analysisId: string,
  gate: Awaited<ReturnType<typeof canCreateTickets>>,
  promotion: PromotionOutcome | null,
): Promise<PublishError> {
  // #406 — ids, counts and the remedy only. The UI builds the route itself, so
  // the server holds no knowledge of UI paths and the client follows no URL it
  // was handed.
  if (gate.allowed) {
    // Issue #723 — count the REQUIREMENT approvals, not every rejection: an
    // evidence or clarification rejection excludes no requirement, so only
    // "approved none, rejected some" means the reviewer left everything out.
    const [approvedRequirements, rejectedRequirements] = await Promise.all([
      prisma.approvalRequest.count({
        where: { analysisId, type: "requirement", status: "approved" },
      }),
      prisma.approvalRequest.count({
        where: { analysisId, type: "requirement", status: "rejected" },
      }),
    ]);
    if (approvedRequirements > 0) {
      // Approved requirements exist and promotion was just retried, yet no row
      // is visible. Say that — never that they were rejected.
      const why =
        promotion && "reason" in promotion
          ? promotion.reason
          : promotion?.status === "already-promoted"
            ? "every promoted requirement has since been deleted"
            : "promotion did not produce any requirement rows";
      return new PublishError(
        400,
        "NO_REQUIREMENTS",
        `analysis has no requirements — ${approvedRequirements} approved requirement(s) could not be promoted (${why})`,
        true,
        { analysisId, approvedCount: approvedRequirements },
      );
    }
    if (rejectedRequirements > 0) {
      // A rejected approval can be reopened on the Analysis page, so point
      // there rather than at a re-run.
      return new PublishError(
        400,
        "APPROVALS_BLOCKING",
        `analysis has no requirements — all ${rejectedRequirements} reviewed requirement(s) were rejected; reopen and approve the ones to keep on the Analysis page`,
        false,
        {
          analysisId,
          pendingCount: gate.pendingCount,
          rejectedCount: gate.rejectedCount,
          action: "resolve",
        },
      );
    }
    return new PublishError(
      400,
      "NO_REQUIREMENTS",
      "analysis has no requirements — run analysis first",
    );
  }
  return new PublishError(
    400,
    "APPROVALS_BLOCKING",
    `analysis has no requirements yet — the approval gate is holding them (${gate.pendingCount} pending approval(s)); resolve them on the Analysis page`,
    false,
    {
      analysisId,
      pendingCount: gate.pendingCount,
      rejectedCount: gate.rejectedCount,
      action: "resolve",
    },
  );
}

function findLiveRequirements(analysisId: string) {
  return prisma.requirement.findMany({
    where: { analysisId, deletedAt: null },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * #744 — whether a reviewer rejected this requirement. Same precedence as
 * `resolveRequirementReviewStatus`: the typed column, else the legacy
 * `review:*` label for rows written before the column existed.
 */
function isRejectedRequirement(r: { reviewStatus: string | null; labels: string }): boolean {
  const legacy = parseLabels(r.labels).find((l) => l.startsWith("review:"));
  return (r.reviewStatus ?? legacy?.slice("review:".length)) === "rejected";
}

/** Draft statuses that a publish run would still pick up (never published). */
const UNPUBLISHED_DRAFT_STATUSES = ["draft", "approved", "failed"];

/**
 * #744 — a rejected requirement must not stay publishable through a draft
 * generated before it was rejected. Generation no longer refreshes such a
 * draft, so it is withdrawn (soft-deleted) instead; a published or in-flight
 * draft is left alone — what already reached the tracker is not undone here.
 */
async function withdrawRejectedDrafts(
  projectId: string,
  rejectedRequirementIds: string[],
): Promise<string[]> {
  if (rejectedRequirementIds.length === 0) return [];
  const where = {
    projectId,
    requirementId: { in: rejectedRequirementIds },
    status: { in: UNPUBLISHED_DRAFT_STATUSES },
    deletedAt: null,
  };
  // Ids are returned (and logged by the caller) so a withdrawn draft carrying
  // a reviewer edit can be recovered if the requirement is reopened.
  const rows = await prisma.issueDraft.findMany({ where, select: { id: true } });
  if (rows.length === 0) return [];
  await prisma.issueDraft.updateMany({
    where: { ...where, id: { in: rows.map((r) => r.id) } },
    data: { deletedAt: new Date() },
  });
  return rows.map((r) => r.id);
}

/**
 * Issue #723 — the analysis's requirements, promoting them first when the gate
 * is open but nothing was promoted. The review PUT promotes as each approval
 * resolves (including a reopened-and-re-reviewed one), but a run stranded
 * before rejections counted as resolved (32 approved, 1 rejected, 0 rows) has
 * an open gate and no review left to make: publishing is one place that run
 * recovers. `promoteApprovedRequirements` is idempotent and never replaces an
 * existing set.
 *
 * Never while the analysis is pending or running: mid-run there is a window
 * where synthesis has finished but cross-doc detection is still running and the
 * orchestrator has not saved its requirements yet. Promoting in that window
 * (a draft generation, or a double-clicked Generate) would race the
 * orchestrator's own save. A failed or cancelled run is terminal, so — like the
 * Analysis page's promote route — it promotes its resolved approvals.
 */
async function loadOrPromoteRequirements(analysisId: string, analysisStatus: string) {
  const requirements = await findLiveRequirements(analysisId);
  if (requirements.length > 0) return requirements;

  const gate = await canCreateTickets(analysisId);
  if (gate.allowed && (analysisStatus === "pending" || analysisStatus === "running")) {
    throw stillRunningError(analysisId, analysisStatus);
  }
  let promotion: PromotionOutcome | null = null;
  if (gate.allowed) {
    try {
      promotion = await promoteApprovedRequirements(analysisId);
    } catch (err) {
      log.warn("lazy promotion before draft generation failed", {
        analysisId,
        error: (err as Error).message,
      });
      promotion = { status: "unavailable", reason: "promoting the requirements failed" };
    }
    if (promotion.status === "promoted" && promotion.requirementCount > 0) {
      const promoted = await findLiveRequirements(analysisId);
      if (promoted.length > 0) return promoted;
    }
  }
  throw await noRequirementsError(analysisId, gate, promotion);
}

/** #863 — whether an analysis is the synthetic anchor of an import run. */
function isImportAnalysis(metadata: string | null): boolean {
  return parseMetadata(metadata).kind === "import";
}

/**
 * #863 — narrow the analysis's requirements to the caller's selection, and
 * refuse to draft an import run above {@link DRAFT_SELECTION_THRESHOLD}
 * wholesale: a 266-issue import used to become 267 drafts in one click.
 * Ids outside the analysis are ignored, never resolved elsewhere.
 */
function selectRequirements<T extends { id: string }>(
  requirements: T[],
  analysis: { id: string; metadata: string | null },
  requirementIds: string[] | undefined,
): T[] {
  if (requirementIds) {
    const wanted = new Set(requirementIds);
    const selected = requirements.filter((r) => wanted.has(r.id));
    if (selected.length === 0) {
      throw new PublishError(
        400,
        "NO_REQUIREMENTS_SELECTED",
        "none of the selected requirements belong to this analysis",
        false,
        { analysisId: analysis.id },
      );
    }
    return selected;
  }
  if (isImportAnalysis(analysis.metadata) && requirements.length > DRAFT_SELECTION_THRESHOLD) {
    throw new PublishError(
      400,
      "DRAFT_SELECTION_REQUIRED",
      `this import holds ${requirements.length} requirements — choose which to draft`,
      false,
      {
        analysisId: analysis.id,
        requirementCount: requirements.length,
        threshold: DRAFT_SELECTION_THRESHOLD,
      },
    );
  }
  return requirements;
}

/**
 * #863 — what Generate would draft from an analysis, so the UI can offer a
 * selection step before an import run becomes hundreds of drafts. Read-only:
 * it never promotes requirements (Generate still does, #723). Scoped to the
 * project, so another project's analysis id is a 404, not a listing.
 */
export async function listDraftCandidates(
  projectId: string,
  analysisId: string,
): Promise<DraftCandidates> {
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, projectId, deletedAt: null },
  });
  if (!analysis) {
    throw new PublishError(404, "ANALYSIS_NOT_FOUND", `analysis not found: ${analysisId}`);
  }
  // #744 — a rejected requirement is never a draft candidate.
  const requirements = (await findLiveRequirements(analysisId)).filter(
    (r) => !isRejectedRequirement(r),
  );
  const source = isImportAnalysis(analysis.metadata) ? "import" : "analysis";
  return {
    analysisId,
    source,
    selectionRequired: source === "import" && requirements.length > DRAFT_SELECTION_THRESHOLD,
    requirements: requirements.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      priority: r.priority,
      externalUrl: r.externalUrl ?? null,
    })),
  };
}

/** #723 — the analysis is still running, so its requirements are not saved yet. */
function stillRunningError(analysisId: string, analysisStatus: string): PublishError {
  return new PublishError(
    400,
    "NO_REQUIREMENTS",
    "analysis has no requirements yet — the analysis is still running; generate drafts once it completes",
    true,
    { analysisId, analysisStatus },
  );
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
  // #744 — rejected requirements produce no draft, and any draft generated
  // for one before it was rejected is withdrawn rather than left publishable.
  const live = await loadOrPromoteRequirements(opts.analysisId, analysis.status);
  const rejectedIds = live.filter(isRejectedRequirement).map((r) => r.id);
  const rejected = new Set(rejectedIds);
  const reviewed = live.filter((r) => !rejected.has(r.id));
  if (reviewed.length === 0) {
    throw new PublishError(
      400,
      "NO_REQUIREMENTS",
      `analysis has no requirements to draft — all ${rejectedIds.length} were rejected; reopen the ones to keep on the Requirements page`,
      false,
      { analysisId: opts.analysisId, rejectedCount: rejectedIds.length },
    );
  }
  const requirements = selectRequirements(reviewed, analysis, opts.requirementIds);
  // Withdraw only after selection validated: a 400 above must leave rows untouched.
  const withdrawnIds = await withdrawRejectedDrafts(opts.projectId, rejectedIds);
  if (withdrawnIds.length > 0) {
    log.info("withdrew drafts of rejected requirements", {
      projectId: opts.projectId,
      analysisId: opts.analysisId,
      withdrawn: withdrawnIds.length,
      withdrawnDraftIds: withdrawnIds,
    });
  }

  const summary: GeneratedDraftSummary = {
    total: 0,
    epics: 0,
    features: 0,
    upserted: 0,
    refreshed: 0,
  };

  // ----- Epic draft -----
  // #23 — titled from the analysed feature, not the analysis id.
  const epicBody = renderEpicBody({ project, analysis, requirements });
  const epicLabels = uniq([
    "epic",
    "metis-generated",
    `priority:${highestPriority(requirements)}`,
    ...(opts.defaultLabels ?? []),
  ]);
  const epic = await claimAndUpsertDraft(opts, buildEpicTitle(project.name, analysis), {
    projectId: opts.projectId,
    requirementId: null,
    parentDraftId: null,
    draftType: "epic",
    body: epicBody,
    labels: epicLabels,
    storyPoints: estimateStoryPoints({ priority: "high", evidenceCount: requirements.length }),
    metadata: {
      analysisId: opts.analysisId,
      requirementIds: requirements.map((r) => r.id),
      generator: "draft-generator/v1",
      ...draftTarget(opts),
    },
  });
  const epicTitle = epic.title;
  summary.total += 1;
  summary.epics += 1;
  if (epic.created) summary.upserted += 1;
  else summary.refreshed += 1;

  // Epic #1107 (#1110) — the panel's confidence for each requirement, so a
  // low-confidence one publishes its caution rather than losing the signal at
  // the GitHub boundary. One query for the whole batch; empty on flag-off runs.
  const confidenceByRequirement = await loadSupportConfidence(requirements);
  // #490 — every requirement's content key, so a same-titled sibling never
  // falls back onto a draft whose text an exact match in this run will claim.
  const reservedKeys = new Set(requirements.map(requirementKey));

  // ----- Feature drafts -----
  for (const req of requirements) {
    // #369 — `[Type] <requirement title>` is shared by every analysis that
    // found a same-titled requirement, so it is claimed like the epic's title.
    const reqTitle = featureDraftTitle(req.type, req.title);
    const draftType = mapReqTypeToDraftType(req.type);
    const labels = uniq([
      draftType,
      "metis-generated",
      `priority:${req.priority}`,
      // #744 — never the hidden `finding:<id>` / `review:*` labels: they name
      // internal rows and would become labels in the target repository.
      ...publishableLabels(parseLabels(req.labels)),
      ...(opts.defaultLabels ?? []),
    ]);
    const body = renderFeatureBody({
      project,
      analysis,
      requirement: req,
      parentTitle: epicTitle,
      supportConfidence: confidenceByRequirement.get(req.id) ?? null,
    });
    const key = requirementKey(req);
    const draft = await claimAndUpsertDraft(
      opts,
      reqTitle,
      {
        projectId: opts.projectId,
        requirementId: req.id,
        parentDraftId: epic.id,
        draftType,
        body,
        labels,
        storyPoints:
          req.storyPoints ??
          estimateStoryPoints({
            priority: req.priority,
            evidenceCount: parseLabels(req.labels).length,
          }),
        metadata: {
          requirementId: req.id,
          analysisId: opts.analysisId,
          type: req.type,
          requirementKey: key,
          ...draftTarget(opts),
        },
      },
      { requirementKey: key, reservedKeys },
    );
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

/**
 * #23 / #369 — a draft's title is its dedup key, and the publisher recomputes
 * the hash from the title, so it must be unique per analysis. Neither an epic
 * title built from the requirement text nor a feature's `[Type] <requirement
 * title>` is: two analyses that share a line produce the same one, and the
 * second would overwrite the first's draft (keeping its approved/published
 * status) and then edit its GitHub issue in place. A draft already owned by
 * another analysis therefore pushes this one to the next free `(n)` suffix; one
 * owned by this analysis is reused, so a re-run still refreshes rather than
 * duplicates.
 *
 * #395 — one analysis can hold two requirements with the same title, so owning
 * analysis alone does not make a draft ours: it is reused only if it is linked
 * to this requirement or to none. A re-run of the analysis re-creates its
 * requirement rows and the FK's ON DELETE SET NULL unlinks the old drafts; the
 * upsert re-links each one it refreshes, so a same-titled sibling later in the
 * same generation no longer qualifies and moves on to the next suffix.
 *
 * #490 — which unlinked draft a requirement takes must not depend on the order
 * the re-run's synthesis emitted the twins in, or the twins swap drafts (and a
 * published issue takes its sibling's text). An unlinked draft whose recorded
 * `requirementKey` matches this requirement's content wins outright; failing
 * that, the first unlinked draft whose key no requirement of this run holds.
 * Requirement bodies come from LLM synthesis, so a real re-run rarely
 * reproduces a key exactly and that order-dependent fallback is the usual path;
 * what keeps a signed-off body safe then is the hold in `upsertDraft`.
 */
async function claimTitle(
  opts: GenerateDraftsOptions,
  baseTitle: string,
  requirementId: string | null,
  match: DraftMatch,
): Promise<{ title: string; hash: string }> {
  let fallback: { title: string; hash: string } | null = null;
  for (let n = 1; ; n++) {
    const title = n === 1 ? baseTitle : `${baseTitle} (${n})`;
    const hash = computeDedupHash(opts.targetOwner, opts.targetRepo, title);
    const holder = await prisma.issueDraft.findFirst({
      where: { projectId: opts.projectId, dedupHash: hash, deletedAt: null },
    });
    if (!holder) return fallback ?? { title, hash };
    if (draftAnalysisId(holder.metadata) !== opts.analysisId) continue;
    if (holder.requirementId === requirementId) return { title, hash };
    if (holder.requirementId !== null) continue;
    const key = draftRequirementKey(holder.metadata);
    if (match.requirementKey !== undefined && key === match.requirementKey) {
      return { title, hash };
    }
    if (!fallback && !(key !== undefined && match.reservedKeys?.has(key))) {
      fallback = { title, hash };
    }
  }
}

/**
 * #733 — the repository a draft was generated for (its dedup hash is keyed on
 * it), recorded so the publish batch form can inherit it instead of
 * defaulting to the repo connector's own repository.
 */
function draftTarget(opts: GenerateDraftsOptions): { targetOwner: string; targetRepo: string } {
  return { targetOwner: opts.targetOwner, targetRepo: opts.targetRepo };
}

/** #490 — how a feature requirement recognises the draft generated from it. */
interface DraftMatch {
  /** This requirement's content key; absent for the epic. */
  requirementKey?: string;
  /** Every requirement key in this generation — not free for a fallback claim. */
  reservedKeys?: ReadonlySet<string>;
}

/**
 * #490 — a requirement's identity across re-runs. `persistRequirements`
 * re-creates the rows with fresh ids, so the id cannot match a draft back to
 * its requirement; the content it was rendered from can.
 */
function requirementKey(req: { type: string; title: string; body: string }): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([req.type, req.title, req.body]))
    .digest("hex");
}

/** Lost races tolerated before a claim gives up and surfaces the conflict. */
const MAX_CLAIM_ATTEMPTS = 5;

/**
 * #369 — `claimTitle` is check-then-act: two concurrent generations can both
 * see a title as free. The partial unique index on `(projectId, dedupHash)
 * WHERE deletedAt IS NULL` makes the loser's insert fail, and the loser then
 * claims again — landing on the winner's draft if it is the same analysis, or
 * on the next free suffix if it is not.
 */
async function claimAndUpsertDraft(
  opts: GenerateDraftsOptions,
  baseTitle: string,
  args: Omit<UpsertArgs, "title" | "dedupHash">,
  match: DraftMatch = {},
): Promise<{ id: string; created: boolean; title: string }> {
  for (let attempt = 1; ; attempt++) {
    const { title, hash } = await claimTitle(opts, baseTitle, args.requirementId, match);
    try {
      return { ...(await upsertDraft({ ...args, title, dedupHash: hash })), title };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= MAX_CLAIM_ATTEMPTS) throw err;
      log.warn("draft title claimed concurrently; re-claiming", { title, attempt });
    }
  }
}

/**
 * #863 — a feature draft's `[Type] <title>`, without doubling a tag the title
 * already carries. An imported upstream issue titled `[Feature]: Add X` used to
 * publish as `[Feature] [Feature]: Add X`. Only a leading tag naming the SAME
 * type is dropped; any other text is the upstream author's and is kept.
 */
export function featureDraftTitle(type: string, title: string): string {
  const trimmed = title.trimStart();
  const tag = /^\[([^\]]{0,64})\]/.exec(trimmed);
  let rest = title;
  if (tag && tag[1]!.trim().toLowerCase() === type.toLowerCase()) {
    const afterTag = trimmed.slice(tag[0].length).trimStart();
    rest = (afterTag.startsWith(":") ? afterTag.slice(1) : afterTag).trimStart();
  }
  return `[${capitalize(type)}] ${rest.length > 0 ? rest : title}`;
}

function draftAnalysisId(metadata: string | null): unknown {
  return parseMetadata(metadata).analysisId;
}

function draftRequirementKey(metadata: string | null): string | undefined {
  const key = parseMetadata(metadata).requirementKey;
  return typeof key === "string" ? key : undefined;
}

function parseMetadata(metadata: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Statuses whose body a human has signed off on or GitHub already carries. */
const FROZEN_ON_RELINK = new Set(["approved", "publishing", "published"]);

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
    // #490 — a re-run unlinked this signed-off draft and it is being re-linked
    // to a requirement whose content is not the one its body was rendered from.
    // Its text stays; only the link moves, and it is logged for review. The
    // hold is recorded as `bodyHeld` so it outlasts the re-link: once linked,
    // the draft would otherwise take the new text on the next (repeatable)
    // Generate. It is released only when the requirement's content matches the
    // stored key again, or the draft leaves the signed-off statuses.
    const existingMeta = parseMetadata(existing.metadata);
    const storedKey = draftRequirementKey(existing.metadata);
    if (
      (existing.requirementId === null || existingMeta.bodyHeld === true) &&
      args.requirementId !== null &&
      FROZEN_ON_RELINK.has(existing.status) &&
      storedKey !== args.metadata.requirementKey
    ) {
      await prisma.issueDraft.update({
        where: { id: existing.id },
        data: {
          requirementId: args.requirementId,
          parentDraftId: args.parentDraftId,
          metadata: JSON.stringify({
            ...args.metadata,
            requirementKey: storedKey,
            bodyHeld: true,
            // #776 — a reviewer's edit outlives the re-link too.
            ...(existingMeta.userEdited === true
              ? {
                  userEdited: true,
                  editedAt: existingMeta.editedAt,
                  editedById: existingMeta.editedById,
                }
              : {}),
          }),
        },
      });
      log.warn("re-linked a signed-off draft to changed requirement content; body kept", {
        draftId: existing.id,
        requirementId: args.requirementId,
        status: existing.status,
      });
      return { id: existing.id, created: false };
    }
    // #776 — a reviewer edited this draft's text. A re-generate refreshes its
    // links and metadata but keeps their title, body and labels; the edit is
    // the point of the review, and silently reverting it would publish the
    // very text they corrected.
    if (existingMeta.userEdited === true) {
      await prisma.issueDraft.update({
        where: { id: existing.id },
        data: {
          requirementId: args.requirementId,
          parentDraftId: args.parentDraftId,
          draftType: args.draftType,
          metadata: JSON.stringify({
            ...args.metadata,
            userEdited: true,
            editedAt: existingMeta.editedAt,
            editedById: existingMeta.editedById,
          }),
          status:
            existing.status === "failed" || existing.status === "draft" ? "draft" : existing.status,
        },
      });
      return { id: existing.id, created: false };
    }
    await prisma.issueDraft.update({
      where: { id: existing.id },
      data: {
        // #395 — re-link: a re-run of the analysis replaced the requirement rows.
        requirementId: args.requirementId,
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
    cleared: isAcceptanceCriteriaCleared(requirement.acceptanceCriteria),
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

/** #863 — re-exported; the implementation lives in @metis/shared so the Edit dialog prefills from the same extraction. */
export const extractBodyAcceptanceCriteria = extractCriteriaFromBody;

function renderAcceptanceCriteria(req: {
  body: string;
  acceptanceCriteria?: string[];
  /** #990 — the user deliberately emptied the list in the editor. */
  cleared?: boolean;
}): string {
  const persisted = (req.acceptanceCriteria ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
  // #990 — the editor is the single source: an explicit clear is honoured and
  // never refilled from the body. Otherwise the body-derived criteria (the
  // section, or a Gherkin body) are exactly what the editor prefills.
  const criteria =
    persisted.length > 0 ? persisted : req.cleared ? [] : deriveBodyAcceptanceCriteria(req.body);
  if (criteria.length > 0) {
    return criteria.map((c) => `- [ ] ${c}`).join("\n");
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
  selectRequirements,
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
