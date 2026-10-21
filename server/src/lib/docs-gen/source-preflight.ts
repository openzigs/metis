/**
 * #1322 — before a document is generated from a repository's source, make sure
 * that source is on disk, or stop before the first model call.
 *
 * A purged clone (directories, no files) used to surface only as a warning in a
 * finished document: "100 of 100 code module(s) could not be read … effectively
 * 0% grounded", after a paid run. Now each git connector in the document's scope
 * goes through `ensureConnectorClone`: a healthy clone is used, one left at the
 * pre-#1322 tmp location is moved across, a missing or hollow one is re-fetched
 * at the code graph's commit — and if none of that works the run throws
 * {@link SourceCloneUnavailableError}, whose fixed message tells the user to
 * re-ingest the repository.
 *
 * Runs before `captureGenerationInputs`, so the snapshot the run is fenced on is
 * taken from the restored source rather than changing under it.
 */
import { REPO_PROVIDER_LOCAL, REPO_PROVIDER_UPLOAD } from "@metis/shared";

import { prisma } from "../prisma.js";
import { ensureConnectorClone, type EnsureCloneOutcome } from "../connectors/repo/clone-health.js";
import { SOURCE_CLONE_UNAVAILABLE_CODE } from "./generation-failure-message.js";

export { SOURCE_CLONE_UNAVAILABLE_CODE };

export interface UnavailableRepository {
  repoConnectorId: string;
  codeGraphId: string;
  reason: Extract<EnsureCloneOutcome, { status: "unavailable" }>["reason"];
}

/** Thrown when a repository's source is missing or hollow and could not be restored. */
export class SourceCloneUnavailableError extends Error {
  readonly code = SOURCE_CLONE_UNAVAILABLE_CODE;
  constructor(readonly repositories: readonly UnavailableRepository[]) {
    super(
      `Source checkout missing or empty for repository ${repositories
        .map((r) => `${r.repoConnectorId} (${r.reason})`)
        .join(", ")}; re-ingest it, then generate again.`,
    );
    this.name = "SourceCloneUnavailableError";
  }
}

export interface SourcePreflightDeps {
  ensureClone: typeof ensureConnectorClone;
}

const defaultDeps: SourcePreflightDeps = {
  ensureClone: (...args) => ensureConnectorClone(...args),
};

/**
 * Check (and repair) the clone of every active git connector whose code graph is
 * in scope. Local and upload connectors have no clone to check, and a graph with
 * no live connector already raises its own `source-unavailable` warning.
 *
 * Returns each connector's outcome; throws {@link SourceCloneUnavailableError}
 * when any could not be made usable.
 */
export async function ensureRepositorySourcesReady(
  scope: { projectId: string; codeGraphId?: string },
  deps: SourcePreflightDeps = defaultDeps,
): Promise<Map<string, EnsureCloneOutcome>> {
  const graphs = await prisma.codeGraph.findMany({
    where: {
      projectId: scope.projectId,
      ...(scope.codeGraphId ? { id: scope.codeGraphId } : {}),
    },
    select: {
      id: true,
      commitSha: true,
      repoConnection: {
        select: { id: true, projectId: true, deletedAt: true, provider: true },
      },
    },
  });
  const outcomes = new Map<string, EnsureCloneOutcome>();
  const unavailable: UnavailableRepository[] = [];
  for (const graph of graphs) {
    const connector = graph.repoConnection;
    if (!connector || connector.projectId !== scope.projectId || connector.deletedAt) continue;
    if (connector.provider === REPO_PROVIDER_LOCAL || connector.provider === REPO_PROVIDER_UPLOAD) {
      continue;
    }
    const outcome = await deps.ensureClone({
      projectId: scope.projectId,
      connectorId: connector.id,
      commitSha: graph.commitSha ?? null,
    });
    outcomes.set(graph.id, outcome);
    if (outcome.status === "unavailable") {
      unavailable.push({
        repoConnectorId: connector.id,
        codeGraphId: graph.id,
        reason: outcome.reason,
      });
    }
  }
  if (unavailable.length > 0) throw new SourceCloneUnavailableError(unavailable);
  return outcomes;
}
