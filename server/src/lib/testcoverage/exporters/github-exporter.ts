/**
 * GitHub test-case exporter (Epic #856, issue #876).
 *
 * Converts generated suggestions into `IssueDraft` rows and enqueues them
 * through the existing publishing pipeline (`createBatch` + `executeBatch`).
 *
 * Each draft gets:
 *   - `draftType = "task"`
 *   - `labels = ["type:test", ...suggestion.tags]`
 *   - `body` rendered from the test-case template (see
 *     `.github/ISSUE_TEMPLATE/test-case.md`) using GWT + acceptance criteria
 *   - `requirementId` linking back to the first mapped requirement (when
 *     present), enabling sub-issue parent linkage upstream.
 *
 * Dry-run short-circuits before the GitHub call and returns the rendered
 * drafts so the UI can preview them. Failures inside the publishing
 * pipeline propagate via the >50% rollback rule already enforced by
 * `runBatch`.
 */
import { prisma } from "../../prisma.js";
import { isUniqueViolation } from "../../db/prisma-errors.js";
import { createBatch, executeBatch } from "../../publishing/publishing-service.js";
import type { CreatePublishBatchInput } from "@metis/shared";

import type { ExportableSuggestion } from "./types.js";

export interface GithubExportOptions {
  readonly projectId: string;
  readonly targetOwner: string;
  readonly targetRepo: string;
  readonly actorId: string;
  readonly secretRef?: string;
  readonly additionalLabels?: ReadonlyArray<string>;
  readonly milestone?: number;
  readonly dryRun?: boolean;
  readonly confirmCrossProject?: boolean;
}

export interface GithubExportResult {
  readonly batchId: string | null;
  readonly draftIds: ReadonlyArray<string>;
  readonly dryRun: boolean;
  readonly previews: ReadonlyArray<{ title: string; body: string; labels: string[] }>;
}

export async function exportSuggestionsToGithub(
  suggestions: ReadonlyArray<ExportableSuggestion>,
  options: GithubExportOptions,
): Promise<GithubExportResult> {
  if (suggestions.length === 0) {
    return { batchId: null, draftIds: [], dryRun: !!options.dryRun, previews: [] };
  }

  const previews = suggestions.map((s) => ({
    title: s.title,
    body: renderTestCaseBody(s),
    labels: dedupe(["type:test", ...(s.tags ?? []), ...(options.additionalLabels ?? [])]),
  }));

  if (options.dryRun) {
    return { batchId: null, draftIds: [], dryRun: true, previews };
  }

  const draftIds: string[] = [];
  for (let i = 0; i < suggestions.length; i += 1) {
    const s = suggestions[i];
    const preview = previews[i];
    draftIds.push(
      await upsertExportDraft(options.projectId, s.id, {
        requirementId: s.mappedRequirementIds[0] ?? null,
        parentDraftId: null,
        draftType: "task",
        title: preview.title,
        body: preview.body,
        labels: JSON.stringify(preview.labels),
        storyPoints: storyPointsFor(s),
        metadata: JSON.stringify({
          source: "test-coverage-export",
          suggestionId: s.id,
          mappedRequirementIds: s.mappedRequirementIds,
          faithfulness: s.faithfulness,
          lowConfidence: s.lowConfidence,
        }),
      }),
    );
  }

  const batchInput: CreatePublishBatchInput = {
    projectId: options.projectId,
    targetOwner: options.targetOwner,
    targetRepo: options.targetRepo,
    provider: "github",
    draftIds,
    dryRun: false,
    additionalLabels: [...(options.additionalLabels ?? [])],
    ...(options.milestone !== undefined ? { milestone: options.milestone } : {}),
    ...(options.secretRef ? { secretRef: options.secretRef } : {}),
    metadata: { exporter: "test-coverage" },
  };
  const batch = await createBatch({
    input: batchInput,
    actorId: options.actorId,
    confirmCrossProject: options.confirmCrossProject,
  });
  await executeBatch({ batchId: batch.id, actorId: options.actorId });
  return { batchId: batch.id, draftIds, dryRun: false, previews };
}

interface ExportDraftContent {
  readonly requirementId: string | null;
  readonly parentDraftId: null;
  readonly draftType: "task";
  readonly title: string;
  readonly body: string;
  readonly labels: string;
  readonly storyPoints: number;
  readonly metadata: string;
}

/**
 * #369 — at most one live draft may hold a `(projectId, dedupHash)`, and the
 * suggestion id is this exporter's dedup key, so a re-export must reuse the
 * suggestion's live draft rather than insert a second one. That includes the
 * drafts a previous export left behind when `createBatch` refused it (#619
 * approval gate): the retry after approval picks them up instead of failing.
 *
 * Status: `approved` is kept; `draft`, `failed` and `published` go back to
 * `draft` so the draft can join the new batch (a published one republishes,
 * and the publisher's title-hash dedup updates its existing issue, as a
 * second draft with the same title did before #369). `publishing` is left
 * alone, so `createBatch` rejects the batch as DRAFT_INELIGIBLE rather than
 * publishing one draft from two batches at once.
 *
 * A concurrent export can insert between the read and the create; the unique
 * index then rejects ours (P2002) and the loop re-reads and updates theirs.
 */
async function upsertExportDraft(
  projectId: string,
  dedupHash: string,
  content: ExportDraftContent,
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const existing = await prisma.issueDraft.findFirst({
      where: { projectId, dedupHash, deletedAt: null },
      select: { id: true, status: true },
    });
    if (existing) {
      await prisma.issueDraft.update({
        where: { id: existing.id },
        data: {
          ...content,
          status: REUSABLE_AS_DRAFT.has(existing.status) ? "draft" : existing.status,
        },
      });
      return existing.id;
    }
    try {
      const created = await prisma.issueDraft.create({
        data: { ...content, projectId, dedupHash, assignees: "[]", status: "draft" },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 2) throw err;
    }
  }
}

const REUSABLE_AS_DRAFT: ReadonlySet<string> = new Set(["draft", "failed", "published"]);

export function renderTestCaseBody(s: ExportableSuggestion): string {
  const stepsBlock = s.steps
    .map((step, idx) => `${idx + 1}. ${step.action}${step.expected ? ` → ${step.expected}` : ""}`)
    .join("\n");

  const reqList = s.mappedRequirementIds.length
    ? s.mappedRequirementIds.map((id) => `- ${id}`).join("\n")
    : "_(none)_";

  return [
    `<!-- generated by metis test-coverage exporter -->`,
    ``,
    `## Acceptance Criteria (Given / When / Then)`,
    ``,
    `**Given**`,
    ``,
    formatBlock(s.gwt.given),
    ``,
    `**When**`,
    ``,
    formatBlock(s.gwt.when),
    ``,
    `**Then**`,
    ``,
    formatBlock(s.gwt.then),
    ``,
    `## Preconditions`,
    ``,
    s.preconditions?.trim() || "_(none)_",
    ``,
    `## Steps`,
    ``,
    stepsBlock || "_(none)_",
    ``,
    `## Expected Result`,
    ``,
    s.expected?.trim() || formatBlock(s.gwt.then) || "_(none)_",
    ``,
    `## Mapped Requirements`,
    ``,
    reqList,
    ``,
    `## Metadata`,
    ``,
    `- Suggestion ID: \`${s.id}\``,
    `- Faithfulness: ${s.faithfulness.toFixed(2)}`,
    `- Low confidence: ${s.lowConfidence ? "**yes**" : "no"}`,
    `- Priority: ${s.priority ?? "(unspecified)"}`,
  ].join("\n");
}

function formatBlock(text: string | ReadonlyArray<string> | undefined): string {
  if (!text) return "";
  const list = Array.isArray(text) ? text : [text as string];
  return list
    .flatMap((s) => s.split(/\r?\n/))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
}

function storyPointsFor(s: ExportableSuggestion): number {
  if (s.priority === "critical") return 5;
  if (s.priority === "high") return 3;
  if (s.priority === "low") return 1;
  return 2;
}

function dedupe(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.filter((v) => v && v.length > 0))];
}
