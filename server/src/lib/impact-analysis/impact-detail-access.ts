/**
 * The read rule for one impact analysis, shared by the REST detail routes
 * (`routes/impact-analysis.ts`) and the `job:{id}` socket room (#655), whose
 * impact-analysis events carry no project of their own.
 */
import type { ImpactAnalysisDetail } from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import {
  isAdminActor,
  listAccessibleProjectIds,
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
 */
export async function loadAccessibleImpactDetail(
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

  const accessible = new Set(await listAccessibleProjectIds(actor));
  if (!detail.projectIds.every((pid) => accessible.has(pid))) {
    throw new AppError(404, "NOT_FOUND", "Impact analysis not found");
  }
  return detail;
}
