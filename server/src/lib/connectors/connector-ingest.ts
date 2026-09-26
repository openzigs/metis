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
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { audit } from "../audit/audit-service.js";
import { getConfigService, type ConfigService } from "../config/config-service.js";
import { isTestSourcePath } from "../docs-gen/module-grouping.js";
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
import {
  indexedCount,
  settledStatus,
  writeSourceIngestState,
  type SourceIngestState,
} from "./source-ingest-state.js";

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
  const ctx = unitContext(projectId, connectorId, kind, actorId);
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
    const outcome = await ingestUnit(ctx, unit);
    if (outcome.action === "created") documentsCreated += 1;
    if (outcome.action === "updated") documentsUpdated += 1;
    if (outcome.failed) failures += 1;
    chunkCount += outcome.chunkCount;
  }
  return { documentsCreated, documentsUpdated, chunkCount, failures };
}

interface UnitContext {
  projectId: string;
  connectorId: string;
  kind: "repo" | "db";
  actorId: string;
  storage: ReturnType<typeof getDocumentStorage>;
  knowledge: ReturnType<typeof getKnowledgeService>;
}

function unitContext(
  projectId: string,
  connectorId: string,
  kind: "repo" | "db",
  actorId: string,
): UnitContext {
  return {
    projectId,
    connectorId,
    kind,
    actorId,
    storage: getDocumentStorage(),
    knowledge: getKnowledgeService(),
  };
}

interface UnitOutcome {
  /** `unchanged`: already indexed with identical content, not re-embedded. */
  action: "created" | "updated" | "unchanged" | "none";
  chunkCount: number;
  failed: boolean;
}

/** Write one unit to storage, upsert its Document row and embed it. Never throws. */
async function ingestUnit(ctx: UnitContext, unit: IngestionUnit): Promise<UnitOutcome> {
  const { projectId, storage, knowledge } = ctx;
  let action: UnitOutcome["action"] = "none";
  try {
    const buffer = Buffer.from(unit.body, "utf-8");
    const blob = await storage.write({ projectId, buffer });
    const existing = await prisma.document.findFirst({
      where: { projectId, filename: unit.filename, deletedAt: null },
    });
    let docId: string;
    if (existing) {
      // Skip re-ingestion if content hasn't changed — makes sync incremental.
      // #182: only a document that FINISHED (indexed) is skipped; one left
      // `processing` / quarantined by an interrupted ingest is re-embedded, which
      // is what makes re-running a sync resume and repair it.
      if (existing.checksum === blob.checksum && existing.indexState === "indexed") {
        return { action: "unchanged", chunkCount: existing.chunkCount ?? 0, failed: false };
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
      action = "updated";
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
          uploadedById: ctx.actorId,
          autoApproveTrusted: true,
        },
      });
      docId = created.id;
      action = "created";
    }
    const result = await knowledge.ingestDocument(docId);
    if (result.status === "ready") return { action, chunkCount: result.chunkCount, failed: false };
    return { action, chunkCount: 0, failed: result.status === "failed" };
  } catch (err) {
    log.warn("connector ingest unit failed", {
      kind: ctx.kind,
      connectorId: ctx.connectorId,
      filename: unit.filename,
      err: (err as Error).message,
    });
    return { action, chunkCount: 0, failed: true };
  }
}

// ---- Source code → RAG ingestion -------------------------------------------

/**
 * Walks a cloned repo directory and ingests source file content into the RAG
 * knowledge base, which grounds document generation and chat and feeds the
 * analysis code agent's retrieval. Issue #182: every eligible file is
 * considered, ordered production code → configuration → tests before the
 * (registry-configurable) file budget applies, large files are chunked rather
 * than skipped, and the run's progress and outcome are recorded on the
 * connector.
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
  /** Issue #182 — override the registry-resolved limits (tests, callers with their own budget). */
  limits?: Partial<SourceIngestLimits>;
}

/** Issue #182 — the limits one repository-source ingest runs under. */
export interface SourceIngestLimits {
  /** Most files embedded per run (`REPO_SOURCE_MAX_FILES`). */
  maxFiles: number;
  /** Largest file embedded, in bytes (`REPO_SOURCE_MAX_FILE_BYTES`); larger is skipped and counted. */
  maxFileBytes: number;
  /** Whether test/spec/fixture files are embedded at all (`REPO_SOURCE_INCLUDE_TESTS`). */
  includeTests: boolean;
  /** Files in flight at once (`REPO_SOURCE_INGEST_CONCURRENCY`). */
  concurrency: number;
}

/** Was a hard-coded 200 — which covered 200 of onyourleft's ~860 eligible files. */
export const DEFAULT_REPO_SOURCE_MAX_FILES = 5000;
/** Was a hard-coded 64 KB with larger files skipped silently; files up to this are now chunked. */
export const DEFAULT_REPO_SOURCE_MAX_FILE_BYTES = 1024 * 1024;
/**
 * One file at a time by default. Embedding is already serialised (one worker,
 * one forward call at a time, one text per call at a quantized dtype — #189,
 * #807), so a second lane only overlaps the per-file database and vector-store
 * writes; on the default SQLite adapter two lanes' interactive transactions were
 * measured colliding ("cannot start a transaction within a transaction",
 * "Unable to start a transaction in the given time") and failing files.
 */
export const DEFAULT_REPO_SOURCE_INGEST_CONCURRENCY = 1;
const MAX_REPO_SOURCE_INGEST_CONCURRENCY = 8;

/** Resolve the limits (runtime config → env → defaults). A non-positive value falls back. */
export function resolveSourceIngestLimits(
  config: Pick<ConfigService, "getNumber" | "getBool"> = getConfigService(),
): SourceIngestLimits {
  const positive = (key: string, fallback: number): number => {
    const n = config.getNumber(key, fallback);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    maxFiles: positive("REPO_SOURCE_MAX_FILES", DEFAULT_REPO_SOURCE_MAX_FILES),
    maxFileBytes: positive("REPO_SOURCE_MAX_FILE_BYTES", DEFAULT_REPO_SOURCE_MAX_FILE_BYTES),
    includeTests: config.getBool("REPO_SOURCE_INCLUDE_TESTS", true),
    concurrency: Math.min(
      positive("REPO_SOURCE_INGEST_CONCURRENCY", DEFAULT_REPO_SOURCE_INGEST_CONCURRENCY),
      MAX_REPO_SOURCE_INGEST_CONCURRENCY,
    ),
  };
}

/** One eligible file found by the walk. */
export interface SourceCandidate {
  absPath: string;
  /** Repository-relative, `/`-separated. */
  relPath: string;
  sizeBytes: number;
}

/**
 * Issue #182 — selection order. The walk yields `readdir` order (alphabetical,
 * depth-first), so `.github/`, `apps/` and `*.test.*` files used up the whole
 * 200-file budget before any of onyourleft's `packages/` business code.
 */
export type SourceTier = "production" | "configuration" | "test";

const SOURCE_TIER_RANK: Record<SourceTier, number> = {
  production: 0,
  configuration: 1,
  test: 2,
};

/** Data and build-configuration formats: embedded after code, before tests. */
const CONFIGURATION_EXTENSIONS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".properties",
  ".gradle",
  ".pom",
]);

/** Test/spec/fixture by the Phase-1 rules (`isTestSourcePath`), then configuration by extension. */
export function sourceTier(relPath: string): SourceTier {
  if (isTestSourcePath(relPath)) return "test";
  return CONFIGURATION_EXTENSIONS.has(path.extname(relPath).toLowerCase())
    ? "configuration"
    : "production";
}

export interface SourceSelection {
  /** In ingest order: production code, configuration, tests; path order within each. */
  selected: SourceCandidate[];
  /** Eligible, within the size limit, but past `maxFiles`. */
  overCap: SourceCandidate[];
  tooLarge: SourceCandidate[];
  excludedTests: SourceCandidate[];
}

/** Order the eligible files and apply the size limit, the test policy and the file budget. */
export function selectSourceFiles(
  candidates: readonly SourceCandidate[],
  limits: Pick<SourceIngestLimits, "maxFiles" | "maxFileBytes" | "includeTests">,
): SourceSelection {
  const tooLarge: SourceCandidate[] = [];
  const excludedTests: SourceCandidate[] = [];
  const ranked: Array<{ file: SourceCandidate; rank: number }> = [];
  for (const file of candidates) {
    const tier = sourceTier(file.relPath);
    if (tier === "test" && !limits.includeTests) {
      excludedTests.push(file);
    } else if (file.sizeBytes > limits.maxFileBytes) {
      tooLarge.push(file);
    } else {
      ranked.push({ file, rank: SOURCE_TIER_RANK[tier] });
    }
  }
  ranked.sort((a, b) =>
    a.rank !== b.rank
      ? a.rank - b.rank
      : a.file.relPath < b.file.relPath
        ? -1
        : a.file.relPath > b.file.relPath
          ? 1
          : 0,
  );
  const ordered = ranked.map((r) => r.file);
  return {
    selected: ordered.slice(0, limits.maxFiles),
    overCap: ordered.slice(limits.maxFiles),
    tooLarge,
    excludedTests,
  };
}

/** Walk the tree and size every eligible file. Only paths and sizes are held, never content. */
async function collectSourceCandidates(
  root: string,
  boundary: string | undefined,
): Promise<{ candidates: SourceCandidate[]; unreadable: string[] }> {
  const candidates: SourceCandidate[] = [];
  const unreadable: string[] = [];
  for await (const absPath of walkSourceFiles(root, { boundary })) {
    const relPath = path.relative(root, absPath).split(path.sep).join("/");
    try {
      // lstat: the walk only yields regular files; never follow a link swapped in since.
      const stat = await fs.lstat(absPath);
      if (!stat.isFile()) {
        unreadable.push(relPath);
        continue;
      }
      candidates.push({ absPath, relPath, sizeBytes: stat.size });
    } catch {
      unreadable.push(relPath);
    }
  }
  return { candidates, unreadable };
}

/** How many skipped paths a log line lists before summarising the rest. */
const LOGGED_PATHS = 20;

function listPaths(files: readonly { relPath: string }[]): string[] {
  const paths = files.slice(0, LOGGED_PATHS).map((f) => f.relPath);
  if (files.length > LOGGED_PATHS) paths.push(`… and ${files.length - LOGGED_PATHS} more`);
  return paths;
}

/** Heartbeat interval: at most one state write per this many ms while files complete. */
const HEARTBEAT_MS = 2000;

/**
 * Serialised, coalescing writer for the run's state: writes happen in order,
 * at most one per {@link HEARTBEAT_MS} unless forced.
 */
function stateWriter(connectorId: string, state: SourceIngestState) {
  let chain: Promise<void> = Promise.resolve();
  let lastWrite = 0;
  return {
    write(force = false): Promise<void> {
      const now = Date.now();
      if (!force && now - lastWrite < HEARTBEAT_MS) return chain;
      lastWrite = now;
      state.heartbeatAt = new Date(now).toISOString();
      const snapshot: SourceIngestState = {
        ...state,
        skipped: { ...state.skipped },
      };
      chain = chain.then(() => writeSourceIngestState(connectorId, snapshot));
      return chain;
    },
  };
}

/** Run `fn` over `items` with at most `concurrency` in flight, in order of start. */
async function forEachBounded<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await fn(item as T);
      }
    },
  );
  await Promise.all(lanes);
}

export async function ingestSourceAsKnowledge(
  projectId: string,
  connectorId: string,
  actorId: string,
  clonePath: string,
  options: IngestSourceOptions = {},
): Promise<IngestSummary> {
  if (!projectId) {
    throw new ConnectorError(400, "PROJECT_REQUIRED", "projectId is required for ingestion");
  }
  const limits: SourceIngestLimits = resolveSourceIngestLimits();
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (value !== undefined) Object.assign(limits, { [key]: value });
  }
  const startedAt = new Date().toISOString();
  const state: SourceIngestState = {
    version: 1,
    runId: randomUUID(),
    status: "running",
    startedAt,
    heartbeatAt: startedAt,
    finishedAt: null,
    eligible: 0,
    selected: 0,
    processed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    chunkCount: 0,
    skipped: { cap: 0, tooLarge: 0, unreadable: 0, excludedTests: 0 },
    limits: {
      maxFiles: limits.maxFiles,
      maxFileBytes: limits.maxFileBytes,
      includeTests: limits.includeTests,
    },
  };
  const writer = stateWriter(connectorId, state);
  // #182 — recorded BEFORE any work, so a run that dies part-way is visible.
  await writer.write(true);
  audit({
    actor: { id: actorId },
    action: "connector.repo.source-ingest.started",
    target: { type: "repo_connector", id: connectorId },
    metadata: { projectId, runId: state.runId, limits: state.limits },
  });

  let failure: unknown = null;
  try {
    const { candidates, unreadable } = await collectSourceCandidates(clonePath, options.boundary);
    const selection = selectSourceFiles(candidates, limits);
    state.eligible = candidates.length + unreadable.length;
    state.selected = selection.selected.length;
    state.skipped = {
      cap: selection.overCap.length,
      tooLarge: selection.tooLarge.length,
      unreadable: unreadable.length,
      excludedTests: selection.excludedTests.length,
    };
    log.info("ingestSourceAsKnowledge: selected source files", {
      projectId,
      connectorId,
      eligible: state.eligible,
      selected: state.selected,
      skipped: state.skipped,
      limits: state.limits,
    });
    if (selection.overCap.length > 0) {
      log.warn("repository source files skipped: REPO_SOURCE_MAX_FILES reached", {
        connectorId,
        maxFiles: limits.maxFiles,
        skipped: selection.overCap.length,
        paths: listPaths(selection.overCap),
      });
    }
    for (const file of selection.tooLarge) {
      log.warn("repository source file skipped: larger than REPO_SOURCE_MAX_FILE_BYTES", {
        connectorId,
        path: file.relPath,
        sizeBytes: file.sizeBytes,
        maxFileBytes: limits.maxFileBytes,
      });
    }
    if (unreadable.length > 0) {
      log.warn("repository source files skipped: unreadable", {
        connectorId,
        paths: listPaths(unreadable.map((relPath) => ({ relPath }))),
      });
    }
    await writer.write(true);

    const ctx = unitContext(projectId, connectorId, "repo", actorId);
    await forEachBounded(selection.selected, limits.concurrency, async (file) => {
      let content: string;
      try {
        content = await fs.readFile(file.absPath, "utf-8");
      } catch {
        state.skipped.unreadable += 1;
        state.processed += 1;
        log.warn("repository source file skipped: unreadable", {
          connectorId,
          path: file.relPath,
        });
        return;
      }
      const ext = path.extname(file.relPath).toLowerCase();
      const outcome = await ingestUnit(ctx, {
        filename: `${REPO_FILENAME_PREFIX}:${connectorId}:src/${file.relPath}`,
        body: `# ${file.relPath}\n\n\`\`\`${ext.slice(1)}\n${content}\n\`\`\`\n`,
      });
      state.processed += 1;
      if (outcome.action === "created") state.created += 1;
      if (outcome.action === "updated") state.updated += 1;
      if (outcome.action === "unchanged") state.unchanged += 1;
      if (outcome.failed) state.failed += 1;
      state.chunkCount += outcome.chunkCount;
      await writer.write();
    });
    state.status = settledStatus(state);
  } catch (err) {
    failure = err;
    state.status = "failed";
    state.error = (err as Error).message;
  }
  state.finishedAt = new Date().toISOString();
  await writer.write(true);

  // Created + updated only: an `unchanged` file was indexed by an earlier run.
  const summary: IngestSummary = {
    documentsCreated: state.created,
    documentsUpdated: state.updated,
    chunkCount: state.chunkCount,
    failures: state.failed,
  };
  const outcome = {
    status: state.status,
    eligible: state.eligible,
    selected: state.selected,
    indexed: indexedCount(state),
    unchanged: state.unchanged,
    skipped: state.skipped,
  };
  const finished = { projectId, connectorId, ...outcome, ...summary };
  if (state.status === "completed") {
    log.info("ingestSourceAsKnowledge: repository source ingest finished", finished);
  } else {
    log.warn("ingestSourceAsKnowledge: repository source ingest finished INCOMPLETE", finished);
  }
  audit({
    actor: { id: actorId },
    action: "connector.repo.source-ingest",
    target: { type: "repo_connector", id: connectorId },
    metadata: { projectId, runId: state.runId, ...outcome, ...summary },
  });
  if (failure) throw failure;
  return summary;
}
