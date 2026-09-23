import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLEANUP_ERROR = "Selected approval cleanup needs another indexing retry.";
/**
 * #98 — what the quarantine list SHOWS for a row holding {@link CLEANUP_ERROR}.
 * The stored text stands in for a raw cleanup exception, so the server routes
 * it through the fixed indexing vocabulary and the page must never echo it.
 */
export const SHOWN_CLEANUP_ERROR =
  "Indexing failed. The details are in the server log; re-index the document to try again.";

/**
 * Park a REAL API-approved document at the post-commit cleanup-failure boundary.
 * Keep its actual SQL chunks, vector/sparse entries and selected journal intact.
 * This checkout stores the selected attempt as QuarantineChunk.ord=-3, not a
 * Document.selectedApprovalAttemptId column. This is state seeding, NOT proof
 * that a storage failure naturally produces this state.
 */
export function parkManualApprovalForReconciliation(documentId: string): void {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const dataRoot = realpathSync(
    process.env.E2E_DATA_DIR ?? path.join(repoRoot, "e2e/test-results/stack-data"),
  );
  const dbFile = realpathSync(process.env.E2E_DB_FILE ?? "");
  const databaseUrl = process.env.E2E_DATABASE_URL ?? `file:${dbFile}`;
  if (
    dbFile !== path.join(dataRoot, "metis-e2e.db") ||
    !databaseUrl.startsWith("file:") ||
    realpathSync(databaseUrl.slice(5)) !== dbFile ||
    dataRoot === realpathSync(path.join(repoRoot, "server")) ||
    dataRoot.startsWith(`${realpathSync(path.join(repoRoot, "server"))}${path.sep}`)
  ) {
    throw new Error("Manual approval fixture requires the dedicated E2E database");
  }

  // Resolve the already-installed SQLite driver from the server workspace.
  // Parameterized SQL only; opening must fail rather than create another DB.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const { createRequire } = require('node:module');
    const load = createRequire(process.argv[1]);
    const db = new (load('better-sqlite3'))(process.argv[2], { fileMustExist: true });
    try {
      db.transaction(() => {
        const documentId = process.argv[3];
        const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
        const journals = db.prepare(
          'SELECT * FROM quarantine_chunks WHERE documentId = ? AND ord = -3'
        ).all(documentId);
        const chunks = db.prepare(
          'SELECT id FROM knowledge_chunks WHERE documentId = ? ORDER BY id'
        ).all(documentId).map(row => row.id);
        if (!doc || doc.deletedAt || doc.indexState !== 'indexed' ||
            documentId.startsWith('gendoc-') || journals.length !== 1 || !chunks.length ||
            journals[0].projectId !== doc.projectId || doc.chunkCount !== chunks.length ||
            JSON.stringify(JSON.parse(journals[0].metadata).approvalChunkIds.sort()) !==
              JSON.stringify(chunks)) {
          throw new Error('Expected a real, consistent selected manual approval');
        }
        db.prepare(
          "UPDATE documents SET indexState = 'reconciling', status = 'failed', errorMessage = ? WHERE id = ?"
        ).run(process.argv[4], documentId);
      })();
    } finally { db.close(); }
  `,
      path.join(repoRoot, "server/package.json"),
      dbFile,
      documentId,
      CLEANUP_ERROR,
    ],
    {
      encoding: "utf8",
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to park manual approval: ${result.error ?? result.stderr}`);
  }
}
