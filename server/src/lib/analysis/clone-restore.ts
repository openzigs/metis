/**
 * #1322 — before an analysis's agentic code pass offers the file tools, put back
 * a clone that has gone missing or hollow (directories, no files: what an OS temp
 * purge leaves), at the commit the connector's code graph was built from.
 *
 * The commit is the CODE GRAPH's — the same source of truth the docs-gen
 * preflight uses (`CodeGraph` is unique per project and connector) — so analysis
 * and documents never disagree about which commit a clone should be at.
 *
 * If it cannot be put back the pass runs as #777 designed: without the file
 * tools, and reporting `repo-clone-unavailable`. A hollow clone is never offered
 * as a working tree — `resolveExistingCloneDir` alone only asks whether the
 * directory exists, and an empty one does.
 *
 * Kept out of `clone-availability.ts` on purpose: tests `vi.mock` that module
 * with only its two exports, and a new export there would break them.
 */
import { REPO_PROVIDER_LOCAL, REPO_PROVIDER_UPLOAD } from "@metis/shared";

import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { resolveRepoClonePath } from "../connectors/repo/clone-path.js";
import { ensureConnectorClone, inspectClone } from "../connectors/repo/clone-health.js";

const log = createChildLogger("analysis-clone-restore");

/** `unusable` ⇒ withhold the file tools; otherwise the clone has files to read. */
export type AnalysisCloneState = "healthy" | "restored" | "unusable";

function warn(connectorId: string, err: unknown): void {
  log.warn("Could not check or restore the repository clone for analysis", {
    connectorId,
    error: err instanceof Error ? err.message : String(err),
  });
}

export async function prepareAnalysisClone(
  projectId: string,
  connectorId: string,
  deps: { ensureClone: typeof ensureConnectorClone } = {
    ensureClone: (...args) => ensureConnectorClone(...args),
  },
): Promise<AnalysisCloneState> {
  let connector: { provider: string } | null = null;
  try {
    connector = await prisma.repoConnection.findFirst({
      where: { id: connectorId, projectId, deletedAt: null },
      select: { provider: true },
    });
  } catch (err) {
    warn(connectorId, err);
  }
  if (
    !connector ||
    connector.provider === REPO_PROVIDER_LOCAL ||
    connector.provider === REPO_PROVIDER_UPLOAD
  ) {
    // Nothing to restore from: offer what is on disk, if it has files.
    const found = await inspectClone(resolveRepoClonePath(connectorId), { requireHead: false });
    return found.state === "healthy" ? "healthy" : "unusable";
  }
  try {
    const outcome = await deps.ensureClone({
      projectId,
      connectorId,
      loadCommitSha: async () =>
        (
          await prisma.codeGraph.findFirst({
            where: { projectId, repoConnectionId: connectorId },
            select: { commitSha: true },
          })
        )?.commitSha ?? null,
    });
    if (outcome.status === "unavailable") return "unusable";
    return outcome.status === "healthy" ? "healthy" : "restored";
  } catch (err) {
    warn(connectorId, err);
    return "unusable";
  }
}
