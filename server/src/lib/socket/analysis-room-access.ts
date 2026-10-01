/**
 * #645 — who may join an `analysis:{id}` room.
 *
 * The room carries the run's progress, failures and `analysis:promotion-blocked`
 * (pending / rejected counts and the block reason), so joining it is a read of
 * the analysis. It takes the same rule as the top-level REST read
 * (`ensureAnalysisAccessible` in `routes/analysis.ts`): the analysis exists and
 * is not soft-deleted, and the caller can reach its project through
 * `assertProjectAccess` — admin bypass, legacy `workspaceId: null` projects open
 * to any authenticated user, otherwise a live member of the project's workspace.
 *
 * Every denial — unknown id, deleted run, another project — answers `false`, so
 * the socket cannot be used as an existence oracle for analysis ids.
 */
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { assertProjectAccess } from "../custom-agents/authz.js";

export async function canJoinAnalysisRoom(user: AuthPayload, analysisId: string): Promise<boolean> {
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, deletedAt: null },
    select: { projectId: true },
  });
  if (!analysis) return false;
  try {
    await assertProjectAccess(user, analysis.projectId);
    return true;
  } catch {
    return false;
  }
}
