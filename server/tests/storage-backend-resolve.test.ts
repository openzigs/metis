/**
 * Epic #518 (#546) — storage-backend helpers + env-selected resolver tests.
 *
 * Covers the shared content-key helper, the storagePath safety guard, and
 * {@link resolveDocumentStorage}'s `UPLOAD_STORAGE_BACKEND` selection (local
 * default, s3 via the registered factory, fail-loud when s3 is selected without
 * a factory, and the fail-safe fallback for unknown values). Mirrors the
 * #541/#542 resolver tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeStoragePath, contentKey } from "../src/lib/documents/storage-backend.js";
import {
  DocumentStorage,
  resolveDocumentStorage,
  __setS3StorageFactory,
  __resetDocumentStorageSingleton,
} from "../src/lib/documents/storage.js";

afterEach(() => {
  // Restore the default (no-factory) state so cases are independent.
  __setS3StorageFactory(() => {
    throw new Error("not registered");
  });
  __resetDocumentStorageSingleton();
});

describe("contentKey", () => {
  it("is deterministic and content-addressed (same bytes -> same key)", () => {
    const a = contentKey("p1", Buffer.from("abc"));
    const b = contentKey("p1", Buffer.from("abc"));
    expect(a.key).toBe(b.key);
    expect(a.checksum).toBe(b.checksum);
    expect(a.key.startsWith("p1/")).toBe(true);
    expect(a.key.endsWith(a.checksum)).toBe(true);
  });

  it("differs by project and by content", () => {
    expect(contentKey("p1", Buffer.from("x")).key).not.toBe(contentKey("p2", Buffer.from("x")).key);
    expect(contentKey("p1", Buffer.from("x")).key).not.toBe(contentKey("p1", Buffer.from("y")).key);
  });

  it("uses POSIX separators so keys are identical across OSes", () => {
    expect(contentKey("p1", Buffer.from("x")).key.includes("\\")).toBe(false);
  });

  it("rejects an invalid projectId", () => {
    expect(() => contentKey("../escape", Buffer.from("x"))).toThrow(/invalid projectId/);
    expect(() => contentKey("a/b", Buffer.from("x"))).toThrow(/invalid projectId/);
  });
});

describe("assertSafeStoragePath", () => {
  it("accepts a normal content key", () => {
    expect(assertSafeStoragePath("p1/aa/bb/deadbeef")).toBe("p1/aa/bb/deadbeef");
  });

  it("accepts the synthetic generated/<id> key", () => {
    expect(assertSafeStoragePath("generated/doc-123")).toBe("generated/doc-123");
  });

  it("refuses traversal, absolute, backslash, and empty segments", () => {
    for (const bad of ["p1/../etc", "../escape", "/abs/path", "p1\\win", "p1//x", ".."]) {
      expect(() => assertSafeStoragePath(bad)).toThrow(/traversal|invalid/);
    }
  });

  it("refuses a non-string / over-long path", () => {
    expect(() => assertSafeStoragePath("" as string)).toThrow(/invalid/);
    expect(() => assertSafeStoragePath("a".repeat(513))).toThrow(/invalid/);
  });
});

describe("resolveDocumentStorage", () => {
  it("defaults to the local DocumentStorage", () => {
    const s = resolveDocumentStorage({
      UPLOAD_DIR: "/tmp/metis-test-uploads",
    } as NodeJS.ProcessEnv);
    expect(s).toBeInstanceOf(DocumentStorage);
  });

  it("falls back to local for an unknown backend value (fail-safe)", () => {
    const s = resolveDocumentStorage({ UPLOAD_STORAGE_BACKEND: "wat" } as NodeJS.ProcessEnv);
    expect(s).toBeInstanceOf(DocumentStorage);
  });

  it("uses the registered S3 factory when UPLOAD_STORAGE_BACKEND=s3", () => {
    const sentinel = { tag: "s3-store" } as unknown as DocumentStorage;
    __setS3StorageFactory(() => sentinel as never);
    const s = resolveDocumentStorage({ UPLOAD_STORAGE_BACKEND: "s3" } as NodeJS.ProcessEnv);
    expect(s).toBe(sentinel);
  });

  it("fails loud when s3 is selected but no factory is registered", () => {
    expect(() =>
      resolveDocumentStorage({ UPLOAD_STORAGE_BACKEND: "s3" } as NodeJS.ProcessEnv),
    ).toThrow(/not registered/);
  });
});
