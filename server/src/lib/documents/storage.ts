/**
 * Document storage (Phase 5 / part of issue #39).
 *
 * Local-disk {@link StorageBackend} implementation. Hash-based storage layout:
 *
 *   <root>/<projectId>/<sha256[0..1]>/<sha256[2..3]>/<sha256>
 *
 * The on-disk path NEVER echoes the client filename — the original name is
 * recorded in the `Document.filename` Prisma column. This eliminates the
 * standard path-traversal vector ("../../etc/passwd" filenames) and means
 * two uploads of the same bytes occupy the same blob (dedupe).
 *
 * Per-project root directory containment is enforced by `path.resolve` +
 * `startsWith` — we refuse to write outside the configured root even if
 * something upstream forgets to validate the projectId.
 *
 * Epic #518 (#546): this is now the `local` backend behind the
 * {@link StorageBackend} seam. The `s3` backend ({@link S3DocumentStorage}) is
 * the multi-replica production option; selection lives in
 * {@link resolveDocumentStorage}. See storage-backend.ts for the rationale.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  assertSafeStoragePath,
  contentKey,
  PROJECT_ID_PATTERN,
  type StorageBackend,
  type StoredBlob,
  type StoreInputBytes,
} from "./storage-backend.js";

export type { StorageBackend, StoredBlob, StoreInputBytes } from "./storage-backend.js";

export interface DocumentStorageOptions {
  root: string;
}

export class DocumentStorage implements StorageBackend {
  private readonly root: string;

  constructor(opts: DocumentStorageOptions) {
    if (!opts.root) throw new Error("DocumentStorage: root is required");
    this.root = path.resolve(opts.root);
  }

  /**
   * Write the buffer under the configured root. Returns the canonical path,
   * checksum, and a `deduplicated` flag callers can use to avoid re-running
   * an expensive ingest pipeline for content that has already been processed.
   */
  async write(input: StoreInputBytes): Promise<StoredBlob> {
    if (!input.buffer || input.buffer.length === 0) {
      throw new Error("DocumentStorage.write: empty buffer");
    }
    const { key, checksum } = contentKey(input.projectId, input.buffer);
    const absolute = this.resolveSafe(key);
    const dedup = existsSync(absolute);
    if (!dedup) {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      const tmp = `${absolute}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, input.buffer, { mode: 0o600 });
      await fs.rename(tmp, absolute);
    }
    return {
      absolutePath: absolute,
      storagePath: key,
      checksum,
      sizeBytes: input.buffer.length,
      deduplicated: dedup,
    };
  }

  /** Read a previously-stored blob back into memory. */
  async read(storagePath: string): Promise<Buffer> {
    const absolute = this.resolveSafe(assertSafeStoragePath(storagePath));
    return fs.readFile(absolute);
  }

  /** True iff a blob exists at `storagePath`. */
  async exists(storagePath: string): Promise<boolean> {
    const absolute = this.resolveSafe(assertSafeStoragePath(storagePath));
    return existsSync(absolute);
  }

  /** Delete a single blob if it exists; safe to call when the file is gone. */
  async remove(storagePath: string): Promise<void> {
    const absolute = this.resolveSafe(assertSafeStoragePath(storagePath));
    try {
      await fs.unlink(absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** Delete an entire project's blob tree (used when a project is archived). */
  async removeProject(projectId: string): Promise<void> {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error("DocumentStorage.removeProject: invalid projectId");
    }
    const dir = this.resolveSafe(projectId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  /** Resolve a relative storage path to an absolute path, refusing escapes. */
  resolveSafe(relative: string): string {
    const resolved = path.resolve(this.root, relative);
    const guard = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (resolved !== this.root && !resolved.startsWith(guard)) {
      throw new Error("DocumentStorage: path traversal refused");
    }
    return resolved;
  }
}

let singleton: StorageBackend | null = null;

/**
 * Resolve the uploads storage backend from config (mirrors #541/#542's
 * env-selected backend style). `UPLOAD_STORAGE_BACKEND`:
 *
 *   - `local` (DEFAULT) — local-disk {@link DocumentStorage} under `UPLOAD_DIR`.
 *   - `s3`              — {@link S3DocumentStorage} (lazily imported so the local
 *                          path never loads the AWS SDK). Fails loud if the
 *                          required bucket config is missing.
 *
 * Unknown values fall back to `local` (fail-safe).
 */
export function resolveDocumentStorage(env: NodeJS.ProcessEnv = process.env): StorageBackend {
  const backend = (env.UPLOAD_STORAGE_BACKEND ?? "local").trim().toLowerCase();
  if (backend === "s3") {
    return createS3Storage(env);
  }
  const root = env.UPLOAD_DIR ?? path.resolve(process.cwd(), "data", "uploads");
  return new DocumentStorage({ root });
}

/**
 * Factory indirection so {@link resolveDocumentStorage} stays free of a static
 * import of the S3 store (which pulls in the AWS SDK). The real factory is
 * registered at startup by the module that owns the S3 client. Until then,
 * fail loud rather than silently degrade to per-pod local — that would
 * re-introduce the cross-replica bug #546 fixes.
 */
let s3StoreFactory: (env: NodeJS.ProcessEnv) => StorageBackend = () => {
  throw new Error(
    "UPLOAD_STORAGE_BACKEND=s3 selected but the S3 storage factory was not " +
      "registered. Ensure storage-backend-s3.ts is imported at startup.",
  );
};

function createS3Storage(env: NodeJS.ProcessEnv): StorageBackend {
  return s3StoreFactory(env);
}

/** Register the S3-backed store factory (called once at startup). */
export function __setS3StorageFactory(factory: (env: NodeJS.ProcessEnv) => StorageBackend): void {
  s3StoreFactory = factory;
  singleton = null;
}

export function getDocumentStorage(): StorageBackend {
  if (!singleton) {
    singleton = resolveDocumentStorage();
  }
  return singleton;
}

/** Test seam — drop the singleton between tests. */
export function __resetDocumentStorageSingleton(): void {
  singleton = null;
}
