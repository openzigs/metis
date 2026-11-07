/**
 * Issue #1918 — rebuild the governing-document vector tables from the text the
 * database already holds (`GoverningDocumentRevision.extractedText`).
 *
 * Two things leave a live revision unsearchable while its row says nothing is
 * wrong, and this sweep repairs both:
 *
 *   - an embedding-model change. A search filters on the active model's
 *     identity, so after a change every governing row is ignored and search
 *     returns `[]`. A workspace whose table holds any row on another identity is
 *     dropped and rebuilt whole: a new model can also change the vector width,
 *     which a Lance table cannot mix. On pgvector the destructive column
 *     migration (`embeddings:migrate prepare`) deletes every governing row, which
 *     reads here as revisions with no rows at all.
 *   - a failed embed at upload, which leaves the revision `pending` with no rows.
 *
 * A revision with no row on the active identity is embedded again and marked
 * `indexed`; one that fails is marked `pending` and reported, and the sweep goes
 * on. `embeddings:migrate reindex --all` runs it after the projects
 * (`reindexAll`, `lib/rag/embed-migration.ts`). Behind `GOVERNING_DOCS_ENABLED`,
 * like every governing job: with the flag off it touches nothing.
 */
import { createChildLogger } from "../logger.js";
import { isGoverningDocsEnabled } from "./flag.js";
import { getGoverningIndex, type GoverningIndex } from "./governing-index.js";
import { listReindexTargets, revisionText, setRevisionIndexState } from "./governing-store.js";

const log = createChildLogger("governing-reindex");

export interface GoverningReindexResult {
  /** `true` when the flag is off and nothing was read or written. */
  skipped: boolean;
  /** Live revisions examined. */
  revisions: number;
  /** Workspaces whose table was dropped and rebuilt because it held another model's rows. */
  rebuiltWorkspaces: string[];
  /** Revisions embedded again, with their chunk counts. */
  reindexed: Array<{ workspaceId: string; revisionId: string; chunkCount: number }>;
  failures: Array<{ workspaceId: string; revisionId: string; error: string }>;
}

export async function reindexGoverningRevisions(
  deps: { index?: GoverningIndex } = {},
): Promise<GoverningReindexResult> {
  const result: GoverningReindexResult = {
    skipped: !isGoverningDocsEnabled(),
    revisions: 0,
    rebuiltWorkspaces: [],
    reindexed: [],
    failures: [],
  };
  if (result.skipped) return result;

  const targets = await listReindexTargets();
  if (targets.length === 0) return result;
  const index = deps.index ?? getGoverningIndex();
  const active = await index.activeEmbeddingIdentity();

  for (const { workspaceId, revisions } of targets) {
    result.revisions += revisions.length;
    const stored = await index.storedIdentities(workspaceId);
    const foreign = [...stored.values()].some((ids) => [...ids].some((id) => id !== active));
    if (foreign) {
      await index.dropWorkspaceTable(workspaceId);
      stored.clear();
      result.rebuiltWorkspaces.push(workspaceId);
    }
    for (const { revisionId, title, indexState } of revisions) {
      if (stored.get(revisionId)?.has(active)) {
        if (indexState !== "indexed") {
          await setRevisionIndexState(workspaceId, revisionId, "indexed");
        }
        continue;
      }
      try {
        const text = await revisionText(workspaceId, revisionId);
        // The upload's filename is not stored; the row's `filename` is metadata only.
        const chunkCount = await index.indexRevision({
          workspaceId,
          revisionId,
          filename: title,
          text: text ?? "",
        });
        await setRevisionIndexState(workspaceId, revisionId, "indexed");
        result.reindexed.push({ workspaceId, revisionId, chunkCount });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("governing revision reindex failed", { workspaceId, revisionId, error });
        await setRevisionIndexState(workspaceId, revisionId, "pending");
        result.failures.push({ workspaceId, revisionId, error });
      }
    }
  }
  return result;
}
