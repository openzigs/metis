/**
 * On-disk roots for upload connectors (#329), in a module with no other
 * imports so the logical-import CLI can anchor imported archive paths (#527)
 * without loading the connector/ingest stack. `archive-extract.ts` re-exports
 * both, so existing callers are unchanged.
 */
import path from "node:path";

/**
 * Root under which all per-connector extraction directories live.
 *
 * Issue #329 — DEFAULT is a PERSISTENT app-data dir (`<cwd>/data/repo-extracts`),
 * mirroring the other on-disk stores (`data/uploads`, `data/repo-clones`,
 * `data/lancedb`). The previous default of `os.tmpdir()` was purged by macOS
 * (`/var/folders/.../T`) and many container runtimes, which silently wiped an
 * upload connector's working copy between ingests. `UPLOAD_EXTRACT_DIR` still
 * overrides it (e.g. to a mounted volume in production).
 */
export function uploadExtractionRoot(): string {
  return path.resolve(
    process.env.UPLOAD_EXTRACT_DIR || path.join(process.cwd(), "data", "repo-extracts"),
  );
}

/**
 * Directory where uploaded .zip archives are persisted for re-ingest.
 *
 * Issue #329 — see {@link uploadExtractionRoot}. The DEFAULT is now
 * `<cwd>/data/repo-archives` (persistent) instead of `os.tmpdir()`, so a stored
 * archive survives OS temp purges and re-ingest can re-extract without requiring
 * the user to re-upload (the intent of #289). `UPLOAD_ARCHIVE_DIR` overrides it.
 */
export function uploadArchiveRoot(): string {
  return path.resolve(
    process.env.UPLOAD_ARCHIVE_DIR || path.join(process.cwd(), "data", "repo-archives"),
  );
}
