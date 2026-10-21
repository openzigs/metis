/**
 * #1322 — before an analysis's agentic code pass offers the file tools, put back
 * a clone that has gone missing or hollow (directories, no files: what an OS temp
 * purge leaves), at the commit the connector's code graph was built from.
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

export async function prepareAnalysisClone(
  projectId: string,
  connectorId: string,
  deps: { ensureClone: typeof ensureConnectorClone } = {
    ensureClone: (...args) => ensureConnectorClone(...args),
  },
): Promise<AnalysisCloneState> {
  const dir = resolveRepoClonePath(connectorId);
  if ((await inspectClone(dir, { requireHead: false })).state === "healthy") return "healthy";
  try {
    const connector = await prisma.repoConnection.findFirst({
      where: { id: connectorId, projectId, deletedAt: null },
      select: { provider: true, lastCommitSha: true },
    });
    if (
      !connector ||
      connector.provider === REPO_PROVIDER_LOCAL ||
      connector.provider === REPO_PROVIDER_UPLOAD
    ) {
      return "unusable";
    }
    const outcome = await deps.ensureClone({
      projectId,
      connectorId,
      commitSha: connector.lastCommitSha ?? null,
    });
    return outcome.status === "unavailable" ? "unusable" : "restored";
  } catch (err) {
    log.warn("Could not check or restore the repository clone for analysis", {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "unusable";
  }
}
