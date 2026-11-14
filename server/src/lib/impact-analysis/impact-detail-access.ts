/**
 * The read rule for one impact analysis, shared by the REST detail routes
 * (`routes/impact-analysis.ts`) and the `job:{id}` socket room (#655), whose
 * impact-analysis events carry no project of their own.
 */
import {
  RESTRICTED_SOURCE_BODY,
  RESTRICTED_SOURCE_TITLE,
  type ImpactAnalysisDetail,
} from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import { prisma } from "../prisma.js";
import {
  restrictedIds,
  userSourceReader,
  type SourceReader,
} from "../analysis/source-redaction.js";
import {
  isAdminActor,
  listMemberAccessibleProjectIds,
  type SchedulerActor,
} from "../scheduler/project-access.js";
import { getImpactAnalysisDetail } from "./impact-analysis-read.js";

/**
 * Issue #963 — load an impact analysis for `actor`, enforcing the SAME tenant
 * isolation as `GET /:id`: the caller must be able to access EVERY project the
 * run touches. Missing run OR any inaccessible project ⇒ 404 (existence is never
 * leaked). Shared by the detail, export, re-run, drift and Jira-publish routes so
 * their authorization is identical (OWASP A01 / BOLA).
 *
 * #88 — the `projectIds.length > 0` guard this used to carry was the detail twin
 * of the hatch #70 removed from the list path: an empty list meant "skip the
 * check", and an empty list was exactly what a run with no items yet produced,
 * so ANY `analysis.read` holder could read another project's in-flight run by id
 * — and export it, and publish it to Jira. `getImpactAnalysisDetail` now names
 * the run's persisted projects (#70's `impact_analysis_projects`), so the check
 * runs on every run created since then.
 *
 * A pre-#70 run with neither persisted projects nor items remains unattributable.
 * Rather than become invisible to everyone, it stays readable by the actor who
 * STARTED it — the one principal with a claim to it — and by nobody else.
 *
 * #1232 — "can access" is the project-access rule (`listMemberAccessibleProjectIds`,
 * the list form of `assertProjectAccess` with the actor's workspaces read live),
 * so a workspace teammate reads a run over the projects they can open. It used
 * to be the projects the actor CREATED. The `job:{id}` socket room of an impact
 * analysis takes this rule too (`resolveJobRoomScope`).
 */
export async function loadAccessibleImpactDetail(
  actor: SchedulerActor,
  id: string,
  /** #2447 — who the result is redacted for: the actor unless the caller says otherwise. */
  reader: SourceReader = userSourceReader(actor.id),
): Promise<ImpactAnalysisDetail> {
  return redactImpactDetail(await loadReadableImpactDetail(actor, id), reader);
}

/**
 * #2447 — the stored result as `reader` may see it: an item about a
 * requirement resting on a source they cannot see shows the placeholder for
 * its title and summary (its scores and code stay), and the run's summary,
 * drawn from every item, goes with it. Nothing is removed.
 */
async function redactImpactDetail(
  detail: ImpactAnalysisDetail,
  reader: SourceReader,
): Promise<ImpactAnalysisDetail> {
  const requirementIds = [
    ...new Set(detail.items.flatMap((i) => (i.requirementId ? [i.requirementId] : []))),
  ];
  if (requirementIds.length === 0) return detail;
  const rows = await prisma.requirement.findMany({
    where: { id: { in: requirementIds } },
    select: { id: true, analysisId: true, sourceIds: true },
  });
  const hidden = await restrictedIds(reader, rows);
  if (hidden.size === 0) return detail;
  return {
    ...detail,
    summary: null,
    items: detail.items.map((i) =>
      i.requirementId && hidden.has(i.requirementId)
        ? { ...i, requirementTitle: RESTRICTED_SOURCE_TITLE, summary: RESTRICTED_SOURCE_BODY }
        : i,
    ),
  };
}

/** The tenant rule: the run, or 404 when the actor may not read it. */
async function loadReadableImpactDetail(
  actor: SchedulerActor,
  id: string,
): Promise<ImpactAnalysisDetail> {
  const detail = await getImpactAnalysisDetail(id);
  if (!detail) {
    throw new AppError(404, "NOT_FOUND", "Impact analysis not found");
  }
  if (isAdminActor(actor)) return detail;

  if (detail.projectIds.length === 0) {
    // Unattributable run: the starter only. A projection that names no starter
    // matches no actor, so it is refused — never defaulted to the caller.
    if (detail.startedById !== actor.id) {
      throw new AppError(404, "NOT_FOUND", "Impact analysis not found");
    }
    return detail;
  }

  const accessible = new Set(await listMemberAccessibleProjectIds(actor));
  if (!detail.projectIds.every((pid) => accessible.has(pid))) {
    throw new AppError(404, "NOT_FOUND", "Impact analysis not found");
  }
  return detail;
}
