/**
 * Epic #518 (#546) — end-to-end proof that the S3 uploads backend gives
 * cross-replica file sharing against a REAL S3-compatible object store (MinIO
 * locally, or AWS S3), using two separately-constructed {@link S3DocumentStorage}
 * instances (= two pods) sharing one bucket.
 *
 *   "A blob written via one storage instance is read back via a SEPARATE
 *    instance sharing the bucket (cross-replica), and a delete on one is seen
 *    by the other."
 *
 * Gated exactly like rate-limit-store-postgres.integration.test.ts: runs only
 * when `RUN_INTEGRATION_TESTS=1` AND the S3 env is configured (via
 * `pnpm test:integration`). In normal CI / local `pnpm test` it is skipped, so
 * no live object store is required. Point it at MinIO with, e.g.:
 *
 *   UPLOAD_S3_BUCKET=metis-test UPLOAD_S3_REGION=us-east-1 \
 *   UPLOAD_S3_ENDPOINT=http://localhost:9000 \
 *   AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
 *   RUN_INTEGRATION_TESTS=1 pnpm --filter @metis/server test:integration
 *
 * The bucket must already exist (MinIO `mc mb`); the backend only puts/gets keys.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { S3DocumentStorage } from "../src/lib/documents/storage-backend-s3.js";

const bucket = (process.env.UPLOAD_S3_BUCKET ?? "").trim();
const region = (process.env.UPLOAD_S3_REGION ?? process.env.AWS_REGION ?? "").trim();
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && bucket !== "" && region !== "";

describe.runIf(enabled)("S3DocumentStorage cross-replica sharing (integration)", () => {
  const opts = {
    bucket,
    region,
    prefix: process.env.UPLOAD_S3_PREFIX,
    endpoint: process.env.UPLOAD_S3_ENDPOINT?.trim() || undefined,
  };
  // Two SEPARATELY-CONSTRUCTED storages sharing ONE bucket = two replicas/pods.
  const podA = new S3DocumentStorage(opts);
  const podB = new S3DocumentStorage(opts);
  const projectId = `it-${Date.now().toString(36)}`;
  const written: string[] = [];

  beforeEach(() => {
    written.length = 0;
  });

  afterAll(async () => {
    await podA.removeProject(projectId).catch(() => {});
  });

  it("podB reads what podA wrote, and a delete propagates", async () => {
    const payload = Buffer.from(`payload-${Math.random()}`);
    const blob = await podA.write({ projectId, buffer: payload });
    written.push(blob.storagePath);

    expect(await podB.exists(blob.storagePath)).toBe(true);
    const read = await podB.read(blob.storagePath);
    expect(read.equals(payload)).toBe(true);

    await podB.remove(blob.storagePath);
    expect(await podA.exists(blob.storagePath)).toBe(false);
  });

  it("dedupes identical content across instances", async () => {
    const payload = Buffer.from("dedupe-me");
    const a = await podA.write({ projectId, buffer: payload });
    const b = await podB.write({ projectId, buffer: payload });
    written.push(a.storagePath);
    expect(a.storagePath).toBe(b.storagePath);
    expect(b.deduplicated).toBe(true);
  });
});
