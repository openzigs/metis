/**
 * Epic #518 (#546) — pluggable uploads storage backend.
 *
 * Background. Uploaded document blobs were written to a *per-pod local volume*
 * (`UPLOAD_DIR`, default `data/uploads`), backed in production by an **RWO PVC**.
 * An RWO PVC can be mounted read-write by at most one node, so a multi-replica
 * deployment (EKS HPA, a load balancer in front of N pods) breaks: a file the
 * upload request wrote on replica A is invisible to replica B's later
 * ingest/read, so downloads/processing fail intermittently. Uploads were the
 * last per-pod-locality blocker to lifting the chart's `replicaCount=1` assert.
 *
 * This module extracts the on-disk {@link DocumentStorage} behind a single
 * {@link StorageBackend} seam and adds a replica-agnostic
 * {@link S3DocumentStorage} (in storage-backend-s3.ts) selected by
 * `UPLOAD_STORAGE_BACKEND=s3`. It mirrors the #541 rate-limit-store / #542
 * SSO-state-store design: an env-selected backend, an in-process/local default
 * for dev, and a shared-store production backend — here S3 (or any
 * S3-compatible object store via an endpoint override, e.g. MinIO).
 *
 * Backend ladder (selected by `UPLOAD_STORAGE_BACKEND`):
 *
 *   - `local` — DEFAULT. {@link DocumentStorage}: content-hash blobs under
 *               `UPLOAD_DIR`. Per-pod / single-replica dev/local — preserves the
 *               exact pre-existing behaviour, no new infra.
 *   - `s3`    — **production / multi-replica setting.** {@link S3DocumentStorage}:
 *               the same content-hash key layout written to an S3 bucket, so any
 *               replica reads what any other replica wrote. Standard AWS
 *               credential resolution (IRSA / instance role / env) — never
 *               hardcoded. Bucket + region + optional key prefix + optional
 *               endpoint (S3-compatible) via env.
 *
 * Unknown values fall back to the local default (fail-safe: a typo degrades to
 * per-pod rather than crashing the upload routes). Selecting `s3` without the
 * required bucket config fails loud — a silent degrade to per-pod would
 * re-introduce the very cross-replica bug this change fixes.
 *
 * The on-disk/object KEY never echoes the client filename — it is content-hash
 * based (see {@link DocumentStorage}), eliminating the path-traversal vector and
 * giving content dedupe for free. The same key layout is shared by both backends
 * so a `storagePath` persisted in the `Document.storagePath` column is portable.
 */
import crypto from "node:crypto";
import path from "node:path";

/** Bytes to store, scoped to a project. */
export interface StoreInputBytes {
  projectId: string;
  buffer: Buffer;
}

/** Result of a successful write. */
export interface StoredBlob {
  /**
   * Backend-local locator of the blob. For the local backend this is the
   * absolute filesystem path; for S3 it is the fully-qualified object key
   * (`s3://bucket/key`). It is NOT persisted and callers must not depend on it
   * being a filesystem path — read/remove always go through {@link storagePath}.
   */
  absolutePath: string;
  /** Backend-agnostic path persisted in `Document.storagePath` (the content key). */
  storagePath: string;
  /** Hex sha256 of the file contents. */
  checksum: string;
  /** Size in bytes (== buffer.length, kept for convenience). */
  sizeBytes: number;
  /** True when the blob already existed at this key (deduplication win). */
  deduplicated: boolean;
}

/**
 * A storage backend for uploaded document blobs. Every read AND write site in
 * the upload lifecycle (upload → store → ingest read → delete) goes through this
 * interface; a stray `fs` path that bypassed it would re-introduce the per-pod
 * bug under multiple replicas.
 *
 * All methods are async because the production (S3) backend is I/O-bound; the
 * local backend awaits `node:fs/promises`.
 */
export interface StorageBackend {
  /**
   * Write `input.buffer` under a content-hash key scoped to `input.projectId`.
   * Returns the canonical key, checksum, and a `deduplicated` flag callers use
   * to skip re-running an expensive ingest for content already stored.
   */
  write(input: StoreInputBytes): Promise<StoredBlob>;
  /** Read a previously-stored blob back into memory by its `storagePath`. */
  read(storagePath: string): Promise<Buffer>;
  /** Delete a single blob if it exists; a no-op when the blob is already gone. */
  remove(storagePath: string): Promise<void>;
  /** True iff a blob exists at `storagePath`. */
  exists(storagePath: string): Promise<boolean>;
  /** Delete an entire project's blob tree (used when a project is archived). */
  removeProject(projectId: string): Promise<void>;
}

export const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Compute the backend-agnostic content key for a blob. Shared by every backend
 * so a `storagePath` is portable across backends:
 *
 *   <projectId>/<sha256[0..1]>/<sha256[2..3]>/<sha256>
 *
 * The key is derived purely from project id + content hash — it never contains
 * any client-supplied filename, so there is no path-traversal surface in the key
 * itself. Uses POSIX separators so the key is identical on every OS and maps
 * cleanly to an S3 key.
 */
export function contentKey(projectId: string, buffer: Buffer): { key: string; checksum: string } {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error("storage: invalid projectId");
  }
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const key = path.posix.join(projectId, checksum.slice(0, 2), checksum.slice(2, 4), checksum);
  return { key, checksum };
}

/**
 * Validate a `storagePath` read back from the DB before it is used to address a
 * blob. We accept exactly the content-key shape {@link contentKey} produces plus
 * the synthetic `generated/<id>` keys used by doc-gen — and reject anything with
 * a `..` traversal segment, an absolute path, or a backslash. This is a
 * defence-in-depth check so a corrupted/forged `storagePath` cannot escape the
 * project prefix or (for S3) the configured key prefix.
 */
export function assertSafeStoragePath(storagePath: string): string {
  if (typeof storagePath !== "string" || storagePath.length === 0 || storagePath.length > 512) {
    throw new Error("storage: invalid storagePath");
  }
  if (storagePath.includes("\\") || storagePath.startsWith("/")) {
    throw new Error("storage: invalid storagePath");
  }
  const segments = storagePath.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new Error("storage: path traversal refused");
    }
  }
  return storagePath;
}
