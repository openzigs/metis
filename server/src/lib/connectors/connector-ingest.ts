/**
 * Connector → RAG ingestion bridge — Phase 8.
 *
 * Both the repo and database connectors transform their fetched material into
 * a small set of synthetic Document rows + storage blobs, then hand them to
 * the existing `KnowledgeService.ingestDocument` pipeline (Phase 5). Reusing
 * the document path means:
 *
 *   - Per-project scoping is already enforced by the vector store.
 *   - PII redaction runs at THIS layer before bytes hit storage.
 *   - The UI's existing "documents" panel surfaces connector-derived docs
 *     for free, with a `connector:<id>:<path>` filename so users can tell
 *     them apart.
 *
 * NEVER cross-projects: all writes are scoped to the connector's projectId
 * and the caller is responsible for verifying the connector belongs to the
 * project before invoking `ingestRepo` / `ingestDbSchema`.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { getDocumentStorage } from "../documents/storage.js";
import { getKnowledgeService } from "../rag/knowledge-service.js";
import { redactString } from "./pii-redactor.js";
import type { ConnectorEmitter } from "./types.js";
import { NOOP_EMITTER, ConnectorError } from "./types.js";
import { isJunkSourcePath } from "@metis/shared";
import type { DbSchemaSnapshot, DbTableInfo } from "@metis/shared";
import type { RepoMetadata } from "./repo/repo-service.js";

const log = createChildLogger("connector-ingest");

export interface IngestSummary {
  documentsCreated: number;
  documentsUpdated: number;
  chunkCount: number;
  failures: number;
}

interface IngestionUnit {
  filename: string;
  body: string;
}

const REPO_FILENAME_PREFIX = "connector:repo";
const DB_FILENAME_PREFIX = "connector:db";

// ---- Repo ingestion --------------------------------------------------------

/** Convert repo metadata into ingestable units (README + key manifests + tree summary). */
export function repoMetadataToUnits(connectorId: string, meta: RepoMetadata): IngestionUnit[] {
  const units: IngestionUnit[] = [];
  const repoFull = meta.repo.full_name;
  const overview =
    `# Repository ${repoFull}\n\n` +
    `- Default branch: ${meta.repo.default_branch}\n` +
    `- Languages: ${Object.keys(meta.languages).join(", ") || "(unknown)"}\n` +
    `- Top-level entries: ${meta.topLevel.map((t) => `${t.type === "dir" ? "/" : ""}${t.name}`).join(", ")}\n` +
    `- HEAD sha: ${meta.headSha ?? "(unknown)"}\n`;
  units.push({
    filename: `${REPO_FILENAME_PREFIX}:${connectorId}:OVERVIEW.md`,
    body: redactString(overview),
  });
  if (meta.readme) {
    units.push({
      filename: `${REPO_FILENAME_PREFIX}:${connectorId}:README.md`,
      body: redactString(meta.readme),
    });
  }
  for (const [name, content] of Object.entries(meta.manifests)) {
    units.push({
      filename: `${REPO_FILENAME_PREFIX}:${connectorId}:${name}`,
      body: `\`\`\`\n${redactString(content)}\n\`\`\`\n`,
    });
  }
  return units;
}

export async function ingestRepoMetadata(
  projectId: string,
  connectorId: string,
  actorId: string,
  meta: RepoMetadata,
  emitter: ConnectorEmitter = NOOP_EMITTER,
): Promise<IngestSummary> {
  const units = repoMetadataToUnits(connectorId, meta);
  const summary = await ingestUnits(projectId, connectorId, "repo", actorId, units, emitter);
  await prisma.repoConnection.update({
    where: { id: connectorId },
    data: { lastIngestAt: new Date() },
  });
  audit({
    actor: { id: actorId },
    action: "connector.repo.ingest",
    target: { type: "repo_connector", id: connectorId },
    metadata: {
      projectId,
      documentsCreated: summary.documentsCreated,
      documentsUpdated: summary.documentsUpdated,
      chunkCount: summary.chunkCount,
      failures: summary.failures,
    },
  });
  return summary;
}

// ---- DB schema ingestion ---------------------------------------------------

export function dbSnapshotToUnits(
  connectorId: string,
  snapshot: DbSchemaSnapshot,
): IngestionUnit[] {
  const units: IngestionUnit[] = [];
  const overview =
    `# Database connector ${connectorId} schema\n\n` +
    `- Driver: ${snapshot.driver}\n` +
    `- Schema: ${snapshot.schema ?? "(default)"}\n` +
    `- Tables: ${snapshot.tables.length}\n` +
    `- Captured: ${snapshot.extractedAt}\n`;
  units.push({
    filename: `${DB_FILENAME_PREFIX}:${connectorId}:OVERVIEW.md`,
    body: redactString(overview),
  });
  for (const t of snapshot.tables) {
    units.push({
      filename: `${DB_FILENAME_PREFIX}:${connectorId}:${t.schema}.${t.name}.md`,
      body: redactString(formatTableMarkdown(t)),
    });
  }
  return units;
}

function formatTableMarkdown(t: DbTableInfo): string {
  const lines: string[] = [];
  lines.push(`# ${t.schema}.${t.name}`);
  if (t.comment) lines.push(`> ${t.comment}`);
  lines.push("");
  lines.push("## Columns");
  lines.push("| Name | Type | Nullable | PK | FK |");
  lines.push("|------|------|----------|----|----|");
  for (const c of t.columns) {
    lines.push(
      `| ${c.name} | ${c.dataType} | ${c.nullable ? "yes" : "no"} | ${c.isPrimaryKey ? "yes" : ""} | ${c.isForeignKey ? "yes" : ""} |`,
    );
  }
  if (t.primaryKey?.length) {
    lines.push("", `**Primary Key**: ${t.primaryKey.join(", ")}`);
  }
  if (t.foreignKeys.length) {
    lines.push("", "## Foreign Keys");
    for (const fk of t.foreignKeys) {
      lines.push(
        `- ${fk.name}: (${fk.columns.join(", ")}) → ${fk.refTable}(${fk.refColumns.join(", ")})`,
      );
    }
  }
  if (t.indexes.length) {
    lines.push("", "## Indexes");
    for (const i of t.indexes) {
      lines.push(`- ${i.name}${i.isUnique ? " [UNIQUE]" : ""}: (${i.columns.join(", ")})`);
    }
  }
  return lines.join("\n") + "\n";
}

export async function ingestDbSchema(
  projectId: string,
  connectorId: string,
  actorId: string,
  snapshot: DbSchemaSnapshot,
  emitter: ConnectorEmitter = NOOP_EMITTER,
): Promise<IngestSummary> {
  const units = dbSnapshotToUnits(connectorId, snapshot);
  const summary = await ingestUnits(projectId, connectorId, "db", actorId, units, emitter);
  await prisma.databaseConnection.update({
    where: { id: connectorId },
    data: { lastIngestAt: new Date() },
  });
  audit({
    actor: { id: actorId },
    action: "connector.db.ingest",
    target: { type: "db_connector", id: connectorId },
    metadata: {
      projectId,
      documentsCreated: summary.documentsCreated,
      documentsUpdated: summary.documentsUpdated,
      chunkCount: summary.chunkCount,
      failures: summary.failures,
    },
  });
  return summary;
}

// ---- Shared ingest path ----------------------------------------------------

async function ingestUnits(
  projectId: string,
  connectorId: string,
  kind: "repo" | "db",
  actorId: string,
  units: IngestionUnit[],
  emitter: ConnectorEmitter,
): Promise<IngestSummary> {
  if (!projectId) {
    throw new ConnectorError(400, "PROJECT_REQUIRED", "projectId is required for ingestion");
  }
  const storage = getDocumentStorage();
  const knowledge = getKnowledgeService();
  let documentsCreated = 0;
  let documentsUpdated = 0;
  let chunkCount = 0;
  let failures = 0;
  let i = 0;
  for (const unit of units) {
    i += 1;
    emitter.progress({
      connectorId,
      projectId,
      kind,
      phase: "ingest",
      step: unit.filename,
      current: i,
      total: units.length,
    });
    try {
      const buffer = Buffer.from(unit.body, "utf-8");
      const blob = await storage.write({ projectId, buffer });
      const existing = await prisma.document.findFirst({
        where: { projectId, filename: unit.filename, deletedAt: null },
      });
      let docId: string;
      if (existing) {
        // Skip re-ingestion if content hasn't changed — makes sync incremental
        if (existing.checksum === blob.checksum && existing.indexState === "indexed") {
          chunkCount += existing.chunkCount ?? 0;
          continue;
        }
        await prisma.document.update({
          where: { id: existing.id },
          data: {
            storagePath: blob.storagePath,
            checksum: blob.checksum,
            sizeBytes: blob.sizeBytes,
            status: "pending",
            errorMessage: null,
            autoApproveTrusted: true,
          },
        });
        docId = existing.id;
        documentsUpdated += 1;
      } else {
        const created = await prisma.document.create({
          data: {
            projectId,
            filename: unit.filename,
            mimeType: "text/markdown",
            sizeBytes: blob.sizeBytes,
            storagePath: blob.storagePath,
            checksum: blob.checksum,
            status: "pending",
            uploadedById: actorId,
            autoApproveTrusted: true,
          },
        });
        docId = created.id;
        documentsCreated += 1;
      }
      const result = await knowledge.ingestDocument(docId);
      if (result.status === "ready") chunkCount += result.chunkCount;
      else if (result.status === "failed") failures += 1;
    } catch (err) {
      log.warn("connector ingest unit failed", {
        kind,
        connectorId,
        filename: unit.filename,
        err: (err as Error).message,
      });
      failures += 1;
    }
  }
  return { documentsCreated, documentsUpdated, chunkCount, failures };
}

// ---- Source code → RAG ingestion -------------------------------------------

/**
 * Walks a cloned repo directory and ingests source file content into the RAG
 * knowledge base so the analysis code agent can retrieve actual source code
 * during its retrieval phase. Limits to a configurable max file count and
 * skips binary/generated files.
 */

/**
 * Dotted source-file extensions ingested into the RAG knowledge base.
 * Exported so the allowlist can be asserted in unit tests. Issue #205 added
 * `.sas` so SAS source is embedded for semantic search.
 */
export const SOURCE_EXTENSIONS = new Set([
  ".java",
  ".kt",
  ".scala",
  ".groovy",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".cs",
  ".sql",
  ".sas",
  ".xml",
  ".yaml",
  ".yml",
  ".json",
  ".properties",
  ".gradle",
  ".pom",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "build",
  "dist",
  "out",
  ".gradle",
  ".idea",
  ".vscode",
  "__pycache__",
  ".next",
]);

const MAX_SOURCE_FILES = 200;
const MAX_FILE_SIZE_BYTES = 64 * 1024; // 64KB per file

/**
 * Options for {@link walkSourceFiles}.
 *
 * `boundary` — issue #288. When set (used by the `local` provider, which walks
 * a real server directory rather than a sandboxed clone), every traversed entry
 * is resolved with `fs.realpath` and SKIPPED if its real location escapes the
 * boundary. This stops a symlink inside the allowlisted directory from leaking
 * files from elsewhere on the server. For GitHub clones `boundary` is omitted,
 * preserving the original (symlink-following) behaviour unchanged.
 */
interface WalkOptions {
  boundary?: string;
}

async function* walkSourceFiles(dir: string, opts: WalkOptions = {}): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    // OS/archive junk: never descend into a `__MACOSX/` tree and never yield an
    // AppleDouble `._*` / `.DS_Store` / `Thumbs.db` file. Catches re-ingest of
    // an already-extracted macOS zip whose junk was written to disk before this
    // filter existed. (Matches on the bare entry name — sufficient because
    // `__MACOSX` is only ever a top-level segment and `._*` is a basename.)
    if (isJunkSourcePath(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    // Symlink-escape guard for the local provider: resolve and require the real
    // target to remain within the boundary. Symlinks that escape are skipped.
    if (opts.boundary) {
      let real: string;
      try {
        real = await fs.realpath(fullPath);
      } catch {
        continue; // dangling symlink or unreadable — skip
      }
      if (real !== opts.boundary && !real.startsWith(opts.boundary + path.sep)) {
        continue;
      }
    }

    // NOTE (#288): symlinked DIRECTORIES are intentionally NOT recursed. A
    // Dirent reports a symlink-to-directory as `isDirectory() === false` (it is
    // a symlink, not a real dir), so this branch is never taken for one — we
    // fail closed and never traverse into a linked tree. The per-entry realpath
    // boundary check above is what guards symlinked FILES. Do not "fix" this
    // into following symlinked dirs: that would reopen the escape vector.
    if (entry.isDirectory()) {
      yield* walkSourceFiles(fullPath, opts);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext)) {
        yield fullPath;
      }
    }
  }
}

export interface IngestSourceOptions {
  /**
   * Issue #288 — confinement boundary (realpath) for symlink-escape protection.
   * Pass the validated local-source realpath for provider="local"; omit for
   * GitHub clones (default behaviour, symlinks followed).
   */
  boundary?: string;
}

export async function ingestSourceAsKnowledge(
  projectId: string,
  connectorId: string,
  actorId: string,
  clonePath: string,
  options: IngestSourceOptions = {},
): Promise<IngestSummary> {
  const units: IngestionUnit[] = [];
  let count = 0;

  for await (const filePath of walkSourceFiles(clonePath, { boundary: options.boundary })) {
    if (count >= MAX_SOURCE_FILES) break;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_SIZE_BYTES) continue;
      const content = await fs.readFile(filePath, "utf-8");
      const relPath = path.relative(clonePath, filePath).split(path.sep).join("/");
      const ext = path.extname(filePath).toLowerCase();
      units.push({
        filename: `${REPO_FILENAME_PREFIX}:${connectorId}:src/${relPath}`,
        body: `# ${relPath}\n\n\`\`\`${ext.slice(1)}\n${content}\n\`\`\`\n`,
      });
      count += 1;
    } catch {
      // Skip files we can't read
    }
  }

  log.info("ingestSourceAsKnowledge: collected source units", {
    projectId,
    connectorId,
    unitCount: units.length,
  });

  const summary = await ingestUnits(projectId, connectorId, "repo", actorId, units, NOOP_EMITTER);

  audit({
    actor: { id: actorId },
    action: "connector.repo.source-ingest",
    target: { type: "repo_connector", id: connectorId },
    metadata: {
      projectId,
      documentsCreated: summary.documentsCreated,
      documentsUpdated: summary.documentsUpdated,
      chunkCount: summary.chunkCount,
      failures: summary.failures,
    },
  });

  return summary;
}
