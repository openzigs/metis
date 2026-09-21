/**
 * Repo-clone availability for the agentic code agent (Issue #777).
 *
 * ── The defect this exists to kill ──────────────────────────────────────────
 * The orchestrator built the clone path as an UNCONDITIONAL STRING…
 *
 *     const cloneDir = input.connectorId
 *       ? `${process.env.REPO_CLONE_DIR || "./data/repos"}/${input.connectorId}`
 *       : undefined;
 *
 * …and `assembleAgenticCodeTools` gated the file tools on that string being TRUTHY.
 * A connector ROW was therefore sufficient to offer `read_file_slice` / `list_files`.
 * Nothing ever asked whether the directory was THERE.
 *
 * A project can legitimately be fully indexed yet have NO CLONE: the clone is reaped
 * after ingest, the worker disk is ephemeral, the instance was redeployed, or the
 * pipeline is ingest-only. In that state both file tools failed on EVERY call — live
 * telemetry (#774) showed 69–71% of ALL tool calls erroring against a 10-turn budget.
 * The agent could query the graph but never read source, so it burned its budget on
 * guaranteed failures, tripped #773's tool-error threshold, and reported ITSELF as
 * retrieval-degraded — which rolled every requirement up to `could-not-verify`.
 *
 * The system already knew how to work without a clone (graph + symbol search need no
 * working tree). It just never checked, so it never degraded to it.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 * {@link resolveExistingCloneDir} returns the path ONLY when it resolves to a readable
 * DIRECTORY. Absent, unreadable, or a plain file ⇒ `undefined` ⇒ the caller withholds
 * the file tools, tells the agent it has no working tree, and raises the
 * `repo-clone-unavailable` capability reason.
 *
 * ASYNC, and called ONCE PER AGENTIC PASS (at tool-assembly time — not per turn and
 * not per tool call), so this never becomes a blocking sync stat on a hot path.
 *
 * TOCTOU is not a concern here: the check picks a TOOL SET, it does not authorize an
 * access. If the clone vanishes mid-run the tools fail exactly as they do today, and
 * the file tools independently re-check (`read_file_slice` / `list_files` both handle
 * a missing `cloneDir`). This gate is about not OFFERING a capability the run does not
 * have — a race can only cost us a few wasted calls, never correctness.
 */
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";

import { resolveRepoClonePath } from "../connectors/repo/clone-path.js";

/**
 * Where a connector's clone WOULD live. Path construction only — it says nothing
 * about whether anything is actually there (that was half the bug; the other half
 * was looking in the WRONG PLACE).
 *
 * #777 — delegates to the SAME helper the ingest pipeline writes with
 * (`server/src/lib/connectors/repo/clone-path.ts`). This module previously
 * defaulted to `./data/repos`, while ingest writes to `<tmpdir>/metis-repo-clones`,
 * so the two never agreed and every `read_file_slice` / `list_files` call failed.
 * Do NOT re-derive this path here — one source of truth, or the bug comes back.
 */
export function cloneDirPath(connectorId: string): string {
  return resolveRepoClonePath(connectorId);
}

/**
 * Resolve a connector's clone directory, but ONLY if it EXISTS and is READABLE.
 *
 * Returns `undefined` when there is no connector, when the path is missing, when it
 * is not a directory, or when the process cannot read/traverse it. `undefined` is the
 * caller's signal to withhold the file tools rather than offer tools that cannot work.
 */
export async function resolveExistingCloneDir(
  connectorId: string | undefined,
): Promise<string | undefined> {
  if (!connectorId) return undefined;
  const dir = cloneDirPath(connectorId);
  try {
    const stats = await stat(dir);
    if (!stats.isDirectory()) return undefined;
    // R_OK: we can read entries. X_OK: we can traverse into it. Both are needed for
    // `list_files` to walk and `read_file_slice` to open — an unreadable clone is, for
    // the agent's purposes, exactly as useless as an absent one.
    await access(dir, fsConstants.R_OK | fsConstants.X_OK);
    return dir;
  } catch {
    return undefined;
  }
}
