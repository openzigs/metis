/**
 * Issue #1580 (`b-7-8`) — edit a requirement in the approval checkpoint.
 *
 * The checkpoint raises one `requirement` approval per reviewed (structured)
 * requirement, and approving promotes that requirement's title and description
 * (#730, `planApprovedRequirementSet`). Until now the only way to change that
 * text was to approve first and edit the promoted row on the hub, so "edit one,
 * then approve" happened in the wrong order. This writes the reviewed title and
 * description of a requirement whose approval is still pending.
 *
 * The approval must be pending: once approved, the requirement is (or is about
 * to be) a row, which the hub edits with its own history; once rejected, it is
 * left out. On Postgres the approval row is locked for the write, so a review
 * of the same approval waits for the edit and the promotion it triggers reads
 * the edited text. The analysis row is locked as every metadata writer locks
 * it (#909).
 */
import type { EditCheckpointRequirementInput } from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import { prisma, resolveDatabaseProvider } from "../prisma.js";
import { lockAnalysisRow, parseMetadata } from "./analysis-service.js";
import { withCheckpointEditor } from "./checkpoint-authorship.js";
import type { StructuredRequirement, StructuredRequirements } from "./types/requirements.js";

/**
 * The requirement with the edit applied. A changed title keeps the extracted
 * one in `extractedTitle` (once: a second retitle keeps the first original),
 * so promotion still joins it to the synthesis item written against it.
 */
export function applyCheckpointEdit(
  requirement: StructuredRequirement,
  edit: EditCheckpointRequirementInput,
): StructuredRequirement {
  const next: StructuredRequirement = { ...requirement };
  if (edit.title !== undefined && edit.title !== requirement.title) {
    next.extractedTitle = requirement.extractedTitle ?? requirement.title;
    next.title = edit.title;
  }
  if (edit.description !== undefined) next.description = edit.description;
  return next;
}

/**
 * Apply `edit` to the structured requirement `approvalId` reviews, scoped to
 * `analysisId` (the caller has tied the analysis to its project, #1097).
 * Returns the requirement as stored.
 *
 * #2436 — `actorId` is recorded as an editor of the requirement in the same
 * write, so the checkpoint sign-off and the direct approval treat them as one
 * of its authors (maker-checker).
 */
export async function editCheckpointRequirement(
  analysisId: string,
  approvalId: string,
  edit: EditCheckpointRequirementInput,
  actorId: string,
): Promise<StructuredRequirement> {
  return prisma.$transaction(async (tx) => {
    await lockAnalysisRow(tx, analysisId);
    if (resolveDatabaseProvider() === "postgresql") {
      await tx.$queryRaw`SELECT 1 FROM "approval_requests" WHERE "id" = ${approvalId} AND "analysisId" = ${analysisId} FOR UPDATE`;
    }
    const approval = await tx.approvalRequest.findFirst({
      where: { id: approvalId, analysisId },
      select: { type: true, itemId: true, status: true },
    });
    if (!approval) {
      throw new AppError(404, "APPROVAL_NOT_FOUND", `Approval request ${approvalId} not found`);
    }
    if (approval.type !== "requirement") {
      throw new AppError(
        400,
        "APPROVAL_NOT_A_REQUIREMENT",
        "Only a requirement can be edited in the approval checkpoint",
      );
    }
    if (approval.status !== "pending") {
      throw new AppError(
        409,
        "APPROVAL_ALREADY_REVIEWED",
        `Approval request ${approvalId} is already ${approval.status}; edit the requirement on the Requirements page instead`,
      );
    }

    const row = await tx.analysis.findFirst({
      where: { id: analysisId },
      select: { metadata: true },
    });
    const metadata = parseMetadata(row?.metadata ?? null);
    const list = metadata.structuredRequirements as StructuredRequirements | undefined;
    const requirements = Array.isArray(list?.requirements) ? list.requirements : [];
    const index = requirements.findIndex((r) => r.id === approval.itemId);
    if (index < 0) {
      throw new AppError(
        404,
        "CHECKPOINT_REQUIREMENT_NOT_FOUND",
        "The requirement this approval reviews is no longer in the reviewed list",
      );
    }
    const edited = applyCheckpointEdit(requirements[index]!, edit);
    const nextRequirements = requirements.map((r, i) => (i === index ? edited : r));
    await tx.analysis.update({
      where: { id: analysisId },
      data: {
        metadata: JSON.stringify({
          ...withCheckpointEditor(
            metadata,
            // #909 — the extraction run the reviewed list belongs to.
            typeof metadata.structuredRunId === "string" ? metadata.structuredRunId : null,
            approval.itemId,
            actorId,
          ),
          structuredRequirements: { ...list, requirements: nextRequirements },
        }),
      },
    });
    return edited;
  });
}
