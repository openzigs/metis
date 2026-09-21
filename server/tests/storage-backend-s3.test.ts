/**
 * Epic #518 (#546) — S3 uploads-storage backend unit tests.
 *
 * Exercises {@link S3DocumentStorage} against a hand-written in-memory fake
 * S3 client (no `aws-sdk-client-mock` dependency, no live AWS). The fake
 * implements `send()` for the same command set the backend issues
 * (Put/Get/Head/Delete/DeleteObjects/ListObjectsV2) over a `Map` keyed by the
 * S3 object key.
 *
 * The headline assertion is the MULTI-REPLICA semantics test: a blob written by
 * one `S3DocumentStorage` instance ("pod A") is read back by a SEPARATE
 * instance ("pod B") that shares the same fake bucket — proving there is no
 * per-pod locality, which is the bug #546 fixes for the RWO-PVC backend.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  S3DocumentStorage,
  createS3StorageFromEnv,
  registerS3Storage,
} from "../src/lib/documents/storage-backend-s3.js";
import { Readable } from "node:stream";
import {
  resolveDocumentStorage,
  __resetDocumentStorageSingleton,
  __setS3StorageFactory,
} from "../src/lib/documents/storage.js";

/**
 * Minimal in-memory stand-in for an S3 bucket shared by N client instances.
 * One {@link FakeBucket} == one bucket; multiple {@link FakeS3Client}s pointed
 * at the same FakeBucket model multiple pods talking to the same real bucket.
 */
class FakeBucket {
  readonly objects = new Map<string, Buffer>();
}

class NotFound extends Error {
  readonly name = "NotFound";
  readonly $metadata = { httpStatusCode: 404 };
}

class FakeS3Client {
  /**
   * `bodyMode` controls how GetObject returns the payload so we can exercise
   * both the `transformToByteArray()` happy path and the async-iterable
   * (Node Readable) fallback in the backend's stream collector.
   * `notFoundShape` lets us assert the backend treats every S3 "missing" signal
   * as absence.
   */
  constructor(
    private readonly bucket: FakeBucket,
    private readonly bodyMode: "bytes" | "stream" = "bytes",
    private readonly notFoundShape: "NotFound" | "NoSuchKey" | "Code404" = "NotFound",
  ) {}

  private notFound(): Error {
    if (this.notFoundShape === "NoSuchKey") {
      const e = new Error("missing") as Error & { name: string };
      e.name = "NoSuchKey";
      return e;
    }
    if (this.notFoundShape === "Code404") {
      const e = new Error("missing") as Error & { $metadata: { httpStatusCode: number } };
      e.$metadata = { httpStatusCode: 404 };
      return e;
    }
    return new NotFound("not found");
  }

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const { Key, Body } = command.input;
      this.bucket.objects.set(String(Key), Buffer.from(Body as Uint8Array));
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const { Key } = command.input;
      if (!this.bucket.objects.has(String(Key))) throw this.notFound();
      return { ContentLength: this.bucket.objects.get(String(Key))!.length };
    }
    if (command instanceof GetObjectCommand) {
      const { Key } = command.input;
      const buf = this.bucket.objects.get(String(Key));
      if (!buf) throw this.notFound();
      if (this.bodyMode === "stream") {
        return { Body: Readable.from([buf]) };
      }
      return {
        Body: {
          transformToByteArray: async () => new Uint8Array(buf),
        },
      };
    }
    if (command instanceof DeleteObjectCommand) {
      const { Key } = command.input;
      this.bucket.objects.delete(String(Key));
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      const { Prefix } = command.input;
      const keys = [...this.bucket.objects.keys()].filter((k) =>
        k.startsWith(String(Prefix ?? "")),
      );
      return {
        Contents: keys.map((Key) => ({ Key })),
        IsTruncated: false,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      const objs = command.input.Delete?.Objects ?? [];
      for (const o of objs) this.bucket.objects.delete(String(o.Key));
      return { Deleted: objs };
    }
    throw new Error(`FakeS3Client: unhandled command ${(command as object).constructor.name}`);
  }
}

function makeStorage(
  bucket: FakeBucket,
  prefix?: string,
  bodyMode: "bytes" | "stream" = "bytes",
  notFoundShape: "NotFound" | "NoSuchKey" | "Code404" = "NotFound",
): S3DocumentStorage {
  return new S3DocumentStorage({
    bucket: "test-bucket",
    region: "us-east-1",
    prefix,
    // The fake satisfies the `send()` shape the backend uses.
    client: new FakeS3Client(
      bucket,
      bodyMode,
      notFoundShape,
    ) as unknown as import("@aws-sdk/client-s3").S3Client,
  });
}

describe("S3DocumentStorage", () => {
  let bucket: FakeBucket;
  let storage: S3DocumentStorage;

  beforeEach(() => {
    bucket = new FakeBucket();
    storage = makeStorage(bucket);
  });

  it("round-trips put -> read", async () => {
    const blob = await storage.write({ projectId: "p1", buffer: Buffer.from("hello s3") });
    expect(blob.storagePath).toContain("p1");
    expect(blob.storagePath).toContain(blob.checksum);
    expect(blob.absolutePath).toMatch(/^s3:\/\/test-bucket\//);
    expect(blob.deduplicated).toBe(false);
    expect(blob.sizeBytes).toBe(8);

    const read = await storage.read(blob.storagePath);
    expect(read.toString()).toBe("hello s3");
  });

  it("deduplicates identical content (no second PUT-as-new)", async () => {
    const a = await storage.write({ projectId: "p1", buffer: Buffer.from("same") });
    const b = await storage.write({ projectId: "p1", buffer: Buffer.from("same") });
    expect(a.storagePath).toBe(b.storagePath);
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(bucket.objects.size).toBe(1);
  });

  it("exists() reflects presence and absence", async () => {
    const blob = await storage.write({ projectId: "p1", buffer: Buffer.from("x") });
    expect(await storage.exists(blob.storagePath)).toBe(true);
    expect(await storage.exists("p1/aa/bb/deadbeef")).toBe(false);
  });

  it("remove() deletes and is idempotent on a missing key", async () => {
    const blob = await storage.write({ projectId: "p1", buffer: Buffer.from("y") });
    await storage.remove(blob.storagePath);
    expect(await storage.exists(blob.storagePath)).toBe(false);
    // Second remove of a now-missing key must not throw.
    await expect(storage.remove(blob.storagePath)).resolves.toBeUndefined();
  });

  it("removeProject() deletes only that project's blobs", async () => {
    await storage.write({ projectId: "p1", buffer: Buffer.from("one") });
    await storage.write({ projectId: "p1", buffer: Buffer.from("two") });
    await storage.write({ projectId: "p2", buffer: Buffer.from("three") });
    await storage.removeProject("p1");
    expect([...bucket.objects.keys()].every((k) => k.startsWith("p2/"))).toBe(true);
    expect(bucket.objects.size).toBe(1);
  });

  it("the object key never contains the client filename (content-addressed)", async () => {
    const blob = await storage.write({ projectId: "p1", buffer: Buffer.from("contents") });
    // storagePath is <projectId>/<2>/<2>/<sha256> — no filename, no traversal.
    expect(blob.storagePath.includes("..")).toBe(false);
    expect(blob.storagePath.split("/")[0]).toBe("p1");
  });

  it("applies the configured key prefix on S3 but keeps storagePath prefix-free", async () => {
    const prefixed = makeStorage(bucket, "uploads");
    const blob = await prefixed.write({ projectId: "p1", buffer: Buffer.from("z") });
    // Persisted path is prefix-free (portable with the local backend)...
    expect(blob.storagePath.startsWith("uploads/")).toBe(false);
    // ...but the actual S3 object key carries the prefix.
    expect([...bucket.objects.keys()][0].startsWith("uploads/p1/")).toBe(true);
    // And a separate prefixed instance reads it back through the prefix-free path.
    const read = await prefixed.read(blob.storagePath);
    expect(read.toString()).toBe("z");
  });

  it("rejects an empty buffer", async () => {
    await expect(storage.write({ projectId: "p1", buffer: Buffer.alloc(0) })).rejects.toThrow(
      /empty buffer/,
    );
  });

  it("rejects an invalid projectId on write", async () => {
    await expect(
      storage.write({ projectId: "../escape", buffer: Buffer.from("x") }),
    ).rejects.toThrow(/invalid projectId/);
  });

  it("refuses a traversal storagePath on read/remove/exists", async () => {
    await expect(storage.read("p1/../../etc/passwd")).rejects.toThrow(/traversal|invalid/);
    await expect(storage.exists("../escape")).rejects.toThrow(/traversal|invalid/);
    await expect(storage.remove("p1/..")).rejects.toThrow(/traversal|invalid/);
  });

  // ── MULTI-REPLICA semantics ───────────────────────────────────────────────
  it("a blob written by one instance is readable by a SEPARATE instance sharing the bucket", async () => {
    // podA and podB are two SEPARATELY-CONSTRUCTED storages over ONE bucket.
    const podA = makeStorage(bucket);
    const podB = makeStorage(bucket);
    const written = await podA.write({
      projectId: "shared",
      buffer: Buffer.from("cross-replica payload"),
    });
    // podB has no local state — it can only see the blob via the shared store.
    expect(await podB.exists(written.storagePath)).toBe(true);
    const read = await podB.read(written.storagePath);
    expect(read.toString()).toBe("cross-replica payload");

    // And a delete on podB is observed by podA (single source of truth).
    await podB.remove(written.storagePath);
    expect(await podA.exists(written.storagePath)).toBe(false);
  });

  it("reads a Node-stream GetObject body via the async-iterable fallback", async () => {
    const streamStorage = makeStorage(bucket, undefined, "stream");
    const blob = await streamStorage.write({ projectId: "p1", buffer: Buffer.from("streamed") });
    const read = await streamStorage.read(blob.storagePath);
    expect(read.toString()).toBe("streamed");
  });

  it.each(["NoSuchKey", "Code404"] as const)(
    "treats the %s missing-object shape as absence",
    async (shape) => {
      const shapeStorage = makeStorage(new FakeBucket(), undefined, "bytes", shape);
      expect(await shapeStorage.exists("p1/aa/bb/none")).toBe(false);
    },
  );

  it("constructs a real S3Client when none is injected (endpoint path-style branch)", () => {
    // No `client` → exercises the real `new S3Client(...)` constructor branch,
    // including the endpoint override / forcePathStyle path. No network call.
    expect(
      () =>
        new S3DocumentStorage({
          bucket: "b",
          region: "us-east-1",
          endpoint: "http://localhost:9000",
        }),
    ).not.toThrow();
    expect(() => new S3DocumentStorage({ bucket: "b", region: "us-east-1" })).not.toThrow();
  });

  it("rejects construction without a bucket or region", () => {
    expect(() => new S3DocumentStorage({ bucket: "", region: "us-east-1" })).toThrow(/bucket/);
    expect(() => new S3DocumentStorage({ bucket: "b", region: "" })).toThrow(/region/);
  });

  it("rejects an invalid projectId on removeProject", async () => {
    await expect(storage.removeProject("../escape")).rejects.toThrow(/invalid projectId/);
  });
});

describe("registerS3Storage", () => {
  afterEach(() => {
    __setS3StorageFactory(() => {
      throw new Error("not registered");
    });
    __resetDocumentStorageSingleton();
  });

  it("wires the resolver so UPLOAD_STORAGE_BACKEND=s3 builds an S3 store", () => {
    registerS3Storage();
    const s = resolveDocumentStorage({
      UPLOAD_STORAGE_BACKEND: "s3",
      UPLOAD_S3_BUCKET: "b",
      UPLOAD_S3_REGION: "us-east-1",
    } as NodeJS.ProcessEnv);
    expect(s).toBeInstanceOf(S3DocumentStorage);
  });
});

describe("createS3StorageFromEnv", () => {
  it("builds a storage from UPLOAD_S3_* env", () => {
    const s = createS3StorageFromEnv({
      UPLOAD_S3_BUCKET: "b",
      UPLOAD_S3_REGION: "eu-west-1",
    } as NodeJS.ProcessEnv);
    expect(s).toBeInstanceOf(S3DocumentStorage);
  });

  it("falls back to AWS_REGION when UPLOAD_S3_REGION is unset", () => {
    const s = createS3StorageFromEnv({
      UPLOAD_S3_BUCKET: "b",
      AWS_REGION: "ap-south-1",
    } as NodeJS.ProcessEnv);
    expect(s).toBeInstanceOf(S3DocumentStorage);
  });

  it("fails loud when the bucket is missing", () => {
    expect(() =>
      createS3StorageFromEnv({ UPLOAD_S3_REGION: "us-east-1" } as NodeJS.ProcessEnv),
    ).toThrow(/UPLOAD_S3_BUCKET/);
  });

  it("fails loud when the region is missing", () => {
    expect(() => createS3StorageFromEnv({ UPLOAD_S3_BUCKET: "b" } as NodeJS.ProcessEnv)).toThrow(
      /UPLOAD_S3_REGION/,
    );
  });
});
