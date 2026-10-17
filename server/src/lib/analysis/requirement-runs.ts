/**
 * #1230 — the project's default requirements run, as the Requirements hub
 * chooses it (#999), read on the server.
 *
 * The hub lists `listAnalysesForProject` (newest first, background rows left
 * out) and opens on `defaultRequirementsRunId` of it. A reader-layout BRD's
 * Approved Requirements section (#1218) must read the SAME run, so this applies
 * the same filter, order and rule to the same rows; only the per-run tally is
 * a count of live rows rather than a count per review status, since the rule
 * reads the total alone.
 */
import { defaultRequirementsRunId } from "@metis/shared";
import { prisma } from "../prisma.js";

/**
 * `Analysis.metadata.source` tags for rows that share the `Analysis` table but
 * are NOT user-facing LLM analysis runs. These background rows (code-graph
 * ingestion, opt-in doc-gen domain web research, etc.) carry zero tokens / no
 * findings, so `listAnalysesForProject` excludes them from the
 * analysis-history UI. Add new background tags here so the doc-gen / ingest
 * write sites and this filter stay in sync.
 */
export const BACKGROUND_ANALYSIS_SOURCES: ReadonlySet<string> = new Set([
  "code-graph-ingest",
  "docs-gen-domain-research",
]);

/** Whether an `Analysis` row is a background row, from its stored `metadata`. */
export function isBackgroundAnalysis(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    const meta = JSON.parse(metadata) as { source?: string } | null;
    return meta?.source !== undefined && BACKGROUND_ANALYSIS_SOURCES.has(meta.source);
  } catch {
    return false;
  }
}

/**
 * The id of the run the Requirements hub opens on for `projectId`: the newest
 * completed run with any live requirements, else the newest completed run;
 * `null` when the project has no completed run. Only this project's rows are
 * read, and only its live requirements are counted.
 */
export async function defaultRequirementsRunIdFor(projectId: string): Promise<string | null> {
  const rows = await prisma.analysis.findMany({
    where: { projectId, deletedAt: null, status: "completed" },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      status: true,
      metadata: true,
      _count: { select: { requirements: { where: { projectId, deletedAt: null } } } },
    },
  });
  return defaultRequirementsRunId(
    rows
      .filter((r) => !isBackgroundAnalysis(r.metadata))
      .map((r) => ({ id: r.id, status: r.status, requirementCount: r._count.requirements })),
  );
}
