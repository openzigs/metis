/**
 * #2338 — keep a connector's commit-history repository in step with its index
 * (ADR 0023). Called by every ingest that builds a code graph (Deep Ingest,
 * Sync, the unattended refresh) right after the graph has recorded its commit.
 *
 *   - `CHAT_CHANGE_HISTORY_TOOL` off: any history on disk is DELETED (the
 *     #2389 review: turning the tool off removes the commit text it kept);
 *   - a `local` / `upload` connector has no history to fetch;
 *   - the history is fetched at the graph's commit, the one the chat citations
 *     of #2325 name, so line ranges mean the same lines; a history already
 *     fetched (or found too large) at that commit is kept as it is.
 *
 * Best effort: it never throws, so a history failure never fails an ingest.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { REPO_PROVIDER_LOCAL, REPO_PROVIDER_UPLOAD } from "@metis/shared";
import { resolveRepoHistoryPath } from "./clone-path.js";
import { getConfigService } from "../../config/config-service.js";
import { createChildLogger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import {
  CHANGE_HISTORY_FLAG,
  FULL_SHA_RE,
  hasHistoryRepository,
  readHistoryState,
  removeHistoryRepository,
  type HistoryFetchOutcome,
} from "./history-repo.js";

const log = createChildLogger("repo-history");

export type HistoryRefreshOutcome =
  | HistoryFetchOutcome
  | { status: "off" | "no_history_for_source" | "no_indexed_commit" | "unchanged" };

export interface HistoryRefreshDeps {
  enabled?: () => boolean;
  fetch?: (projectId: string, id: string, commitSha: string) => Promise<HistoryFetchOutcome>;
}

async function defaultFetch(
  projectId: string,
  id: string,
  commitSha: string,
): Promise<HistoryFetchOutcome> {
  const { fetchConnectorHistory } = await import("./repo-service.js");
  return fetchConnectorHistory(projectId, id, commitSha);
}

export async function refreshConnectorHistory(
  projectId: string,
  connectorId: string,
  deps: HistoryRefreshDeps = {},
): Promise<HistoryRefreshOutcome> {
  try {
    const enabled = deps.enabled ?? (() => getConfigService().getBool(CHANGE_HISTORY_FLAG, false));
    if (!enabled()) {
      if (await hasHistoryRepository(connectorId)) await removeHistoryRepository(connectorId);
      return { status: "off" };
    }
    const conn = await prisma.repoConnection.findFirst({
      where: { id: connectorId, projectId, deletedAt: null },
      select: { provider: true },
    });
    if (!conn || conn.provider === REPO_PROVIDER_LOCAL || conn.provider === REPO_PROVIDER_UPLOAD) {
      return { status: "no_history_for_source" };
    }
    const graph = await prisma.codeGraph.findFirst({
      where: { projectId, repoConnectionId: connectorId },
      select: { commitSha: true },
    });
    const commitSha = graph?.commitSha ?? null;
    if (!commitSha || !FULL_SHA_RE.test(commitSha)) return { status: "no_indexed_commit" };
    const state = await readHistoryState(connectorId);
    if (
      state &&
      state.commitSha === commitSha &&
      (state.status === "too_large" ||
        (state.status === "ready" &&
          (await fs.access(path.join(resolveRepoHistoryPath(connectorId), "HEAD")).then(
            () => true,
            () => false,
          ))))
    ) {
      return { status: "unchanged" };
    }
    const outcome = await (deps.fetch ?? defaultFetch)(projectId, connectorId, commitSha);
    if (outcome.status === "ready") {
      log.info("Fetched repository commit history", {
        connectorId,
        sizeBytes: outcome.sizeBytes,
        prefetchedObjects: outcome.prefetchedObjects,
      });
    } else {
      log.warn("Repository commit history not kept", { connectorId, outcome });
    }
    return outcome;
  } catch (err) {
    log.warn("Repository commit history refresh failed", {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "failed", reason: "history refresh failed" };
  }
}
