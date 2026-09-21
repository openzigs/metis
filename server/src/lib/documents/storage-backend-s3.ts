/**
 * Epic #518 (#546) — S3 (object-storage) uploads backend.
 *
 * The replica-agnostic production backend for the {@link StorageBackend} seam:
 * the same content-hash key layout the local backend uses, written to an S3
 * bucket so any replica reads what any other replica wrote (lifting the per-pod
 * RWO-PVC locality that forced `replicaCount=1`). Also targets S3-compatible
 * stores (MinIO, etc.) via an endpoint override.
 *
 * Credentials. We never construct credentials from env in code — the
 * `S3Client` uses the AWS SDK's default credential provider chain (IRSA via the
 * pod's projected service-account token on EKS, an EC2/ECS instance role, or
 * `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env for local/dev against MinIO).
 * No secret ever lives in code or config files.
 *
 * Config (env):
 *   - UPLOAD_S3_BUCKET   (required)  target bucket.
 *   - UPLOAD_S3_REGION   (required)  bucket region (or AWS_REGION).
 *   - UPLOAD_S3_PREFIX   (optional)  key prefix, e.g. "uploads" → "uploads/<key>".
 *   - UPLOAD_S3_ENDPOINT (optional)  endpoint override for S3-compatible stores;
 *                                    forces path-style addressing when set.
 *
 * Keys are content-hash based (see storage-backend.ts) so they never contain a
 * client filename; the stored `storagePath` is the prefix-less content key, kept
 * portable with the local backend. The optional prefix is applied only when
 * talking to S3 and stripped from the persisted path.
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  assertSafeStoragePath,
  contentKey,
  PROJECT_ID_PATTERN,
  type StorageBackend,
  type StoredBlob,
  type StoreInputBytes,
} from "./storage-backend.js";
import { __setS3StorageFactory } from "./storage.js";

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Optional key prefix; applied to S3 object keys only, never persisted. */
  prefix?: string;
  /** Optional endpoint override for S3-compatible stores (forces path-style). */
  endpoint?: string;
  /** Injected client for tests; defaults to a real {@link S3Client}. */
  client?: S3Client;
}

/** Normalise a prefix to either "" or "trimmed/" (no leading slash, one trailing). */
function normalisePrefix(raw: string | undefined): string {
  const p = (raw ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return p ? `${p}/` : "";
}

export class S3DocumentStorage implements StorageBackend {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3StorageOptions) {
    if (!opts.bucket) throw new Error("S3DocumentStorage: bucket is required");
    if (!opts.region) throw new Error("S3DocumentStorage: region is required");
    this.bucket = opts.bucket;
    this.prefix = normalisePrefix(opts.prefix);
    this.client =
      opts.client ??
      new S3Client({
        region: opts.region,
        // Default credential provider chain (IRSA / instance role / env) — no
        // hardcoded credentials.
        ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
      });
  }

  /** Map a persisted content key to the actual S3 object key (adds the prefix). */
  private objectKey(storagePath: string): string {
    return `${this.prefix}${storagePath}`;
  }

  async write(input: StoreInputBytes): Promise<StoredBlob> {
    if (!input.buffer || input.buffer.length === 0) {
      throw new Error("S3DocumentStorage.write: empty buffer");
    }
    const { key, checksum } = contentKey(input.projectId, input.buffer);
    const objectKey = this.objectKey(key);
    const deduplicated = await this.headExists(objectKey);
    if (!deduplicated) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: input.buffer,
          ContentLength: input.buffer.length,
        }),
      );
    }
    return {
      absolutePath: `s3://${this.bucket}/${objectKey}`,
      storagePath: key,
      checksum,
      sizeBytes: input.buffer.length,
      deduplicated,
    };
  }

  async read(storagePath: string): Promise<Buffer> {
    const objectKey = this.objectKey(assertSafeStoragePath(storagePath));
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
    const body = res.Body;
    if (!body) throw new Error(`S3DocumentStorage.read: empty body for ${storagePath}`);
    return streamToBuffer(body);
  }

  async exists(storagePath: string): Promise<boolean> {
    const objectKey = this.objectKey(assertSafeStoragePath(storagePath));
    return this.headExists(objectKey);
  }

  async remove(storagePath: string): Promise<void> {
    const objectKey = this.objectKey(assertSafeStoragePath(storagePath));
    // S3 DeleteObject is idempotent — deleting a missing key succeeds.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  async removeProject(projectId: string): Promise<void> {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error("S3DocumentStorage.removeProject: invalid projectId");
    }
    const projectPrefix = `${this.prefix}${projectId}/`;
    let continuationToken: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: projectPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === "string");
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  /** HEAD the object; treat a 404/NotFound as "does not exist". */
  private async headExists(objectKey: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
}

/** True for the various shapes S3 uses to signal a missing object. */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  return (
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.Code === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/** Collect an S3 GetObject body (web or Node stream / blob) into a Buffer. */
async function streamToBuffer(body: unknown): Promise<Buffer> {
  // AWS SDK v3 exposes `transformToByteArray()` on the SdkStream body.
  const maybe = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof maybe.transformToByteArray === "function") {
    return Buffer.from(await maybe.transformToByteArray());
  }
  // Fallback: async-iterable Node Readable.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Build an {@link S3DocumentStorage} from env. Fails loud when the required
 * bucket config is missing — a silent fallback to per-pod local storage would
 * re-introduce the cross-replica bug #546 fixes.
 */
export function createS3StorageFromEnv(env: NodeJS.ProcessEnv = process.env): S3DocumentStorage {
  const bucket = (env.UPLOAD_S3_BUCKET ?? "").trim();
  const region = (env.UPLOAD_S3_REGION ?? env.AWS_REGION ?? "").trim();
  if (!bucket) {
    throw new Error("UPLOAD_STORAGE_BACKEND=s3 requires UPLOAD_S3_BUCKET");
  }
  if (!region) {
    throw new Error("UPLOAD_STORAGE_BACKEND=s3 requires UPLOAD_S3_REGION (or AWS_REGION)");
  }
  return new S3DocumentStorage({
    bucket,
    region,
    prefix: env.UPLOAD_S3_PREFIX,
    endpoint: env.UPLOAD_S3_ENDPOINT?.trim() || undefined,
  });
}

/**
 * Register the S3-backed uploads-storage factory (called once at startup).
 * Registering is cheap and side-effect-free — no AWS client is constructed and
 * no bucket config is read unless `UPLOAD_STORAGE_BACKEND=s3` is actually
 * selected by {@link resolveDocumentStorage}.
 */
export function registerS3Storage(): void {
  __setS3StorageFactory((env) => createS3StorageFromEnv(env));
}
