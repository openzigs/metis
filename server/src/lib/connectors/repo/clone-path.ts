/**
 * The SINGLE source of truth for where a repository connector's working tree lives.
 *
 * Issue #777. Before this module, two sides derived the clone path independently
 * and disagreed:
 *
 *   - ingest (`repo-service.ts`) wrote to
 *       REPO_CLONE_DIR ? resolveDataDir(REPO_CLONE_DIR) : <tmpdir>/metis-repo-clones
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
 * NOTE: the default root lives under the OS temp directory, which means the OS
 * may reap it. A project can therefore be fully indexed (code graph + RAG intact)
 * while its working tree is gone — that is a normal steady state, not an error.
 * Callers that need to READ FILES must check existence; see `resolveExistingCloneDir`
 * in `../../analysis/clone-availability.ts`.
 */
export function resolveRepoCloneRoot(): string {
  return process.env.REPO_CLONE_DIR
    ? resolveDataDir(process.env.REPO_CLONE_DIR)
    : path.resolve(path.join(os.tmpdir(), "metis-repo-clones"));
}

/**
 * Where connector `connectorId`'s clone lives. Path construction only — it says
 * nothing about whether anything is actually there.
 */
export function resolveRepoClonePath(connectorId: string): string {
  return path.join(resolveRepoCloneRoot(), connectorId);
}
