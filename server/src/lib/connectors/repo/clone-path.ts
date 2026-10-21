/**
 * The SINGLE source of truth for where a repository connector's working tree lives.
 *
 * Issue #777. Before this module, two sides derived the clone path independently
 * and disagreed:
 *
 *   - ingest (`repo-service.ts`) wrote to
 *       REPO_CLONE_DIR ? resolveDataDir(REPO_CLONE_DIR) : <tmpdir>/metis-repo-clones
 *     (the default is `<server>/data/repo-clones` since #1322)
 *   - the analysis orchestrator read from
 *       `${REPO_CLONE_DIR || "./data/repos"}/${connectorId}`   // cwd-relative, different root
 *
 * With `REPO_CLONE_DIR` unset — the default — those are entirely different
 * directories, so `read_file_slice` / `list_files` failed on EVERY call: the
 * agent could query the code graph but could never read source. Post-#773 those
 * failures then drove `code-retrieval-degraded`, collapsing every requirement to
 * `could-not-verify`.
 *
 * Anything that needs a connector's clone path MUST come through here. Do not
 * re-derive it — that is the bug class this module exists to close.
 */
import os from "node:os";
import path from "node:path";

import { resolveDataDir } from "../../server-root.js";

/**
 * Root directory holding every connector's clone, one subdirectory per connector.
 *
 * `REPO_CLONE_DIR` is resolved via {@link resolveDataDir} (anchored to the stable
 * server root, NOT `process.cwd()` — a cwd-relative path drifts with the working
 * directory of whichever process happens to be running).
 *
 * #1322 — the default is `<server>/data/repo-clones`, next to `uploads/` and
 * `lancedb/`. It used to be `<os.tmpdir()>/metis-repo-clones`, which macOS and
 * container restarts purge: a clone was found holding 145 directories and no
 * files, and a paid BRD was generated from no source. The old location is read
 * only to move an existing clone across ({@link legacyTmpCloneRoot}).
 *
 * A clone can still go missing (an emptyDir volume, a pod on another node), so
 * callers that need to READ FILES must check it: `inspectClone` /
 * `ensureConnectorClone` in `./clone-health.ts`.
 */
export function resolveRepoCloneRoot(): string {
  return resolveDataDir(process.env.REPO_CLONE_DIR, "repo-clones");
}

/**
 * #1322 — the pre-#1322 default root (`<tmpdir>/metis-repo-clones`). Only
 * consulted when `REPO_CLONE_DIR` is unset, so an install upgraded from the old
 * default can move across a clone the OS has not reaped yet. Never written to.
 */
export function legacyTmpCloneRoot(): string | null {
  if (process.env.REPO_CLONE_DIR?.trim()) return null;
  return path.resolve(path.join(os.tmpdir(), "metis-repo-clones"));
}

/**
 * Where connector `connectorId`'s clone lives. Path construction only — it says
 * nothing about whether anything is actually there.
 */
export function resolveRepoClonePath(connectorId: string): string {
  return path.join(resolveRepoCloneRoot(), connectorId);
}
