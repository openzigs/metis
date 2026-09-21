/**
 * #785 — cache-path resolution and the Windows MAX_PATH headroom advisory.
 *
 * `checkCachePathHeadroom` takes `platform` as a PARAMETER precisely so the win32
 * branch is testable from macOS/Linux. That is the honest boundary: the arithmetic
 * and the advisory are verified here; the claim that Windows itself enforces a
 * 260-character MAX_PATH is documented (see the module header) and cannot be
 * exercised on this platform.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CACHE_SUFFIX_BUDGET,
  MAX_PATH_LIMIT,
  UNPINNED_CACHE,
  checkCachePathHeadroom,
  readRuntimeCacheDir,
  resolveCachePath,
} from "./embed-cache.js";

describe("resolveCachePath", () => {
  it("pins to TRANSFORMERS_CACHE when set, resolved to an absolute path", () => {
    expect(resolveCachePath({ TRANSFORMERS_CACHE: "/data/hf-cache" } as NodeJS.ProcessEnv)).toBe(
      path.resolve("/data/hf-cache"),
    );
  });

  it("prefers TRANSFORMERS_CACHE over the runtime-reported dir", () => {
    expect(
      resolveCachePath({ TRANSFORMERS_CACHE: "/pinned" } as NodeJS.ProcessEnv, "/runtime/reported"),
    ).toBe(path.resolve("/pinned"));
  });

  it("falls back to the dir transformers.js actually resolved", () => {
    expect(resolveCachePath({} as NodeJS.ProcessEnv, "/node_modules/.cache/huggingface")).toBe(
      path.resolve("/node_modules/.cache/huggingface"),
    );
  });

  it("reports UNPINNED_CACHE — never a guessed path — when nothing pins it", () => {
    expect(resolveCachePath({} as NodeJS.ProcessEnv, null)).toBe(UNPINNED_CACHE);
  });
});

describe("readRuntimeCacheDir", () => {
  it("resolves to a string or null without throwing", async () => {
    // @huggingface/transformers is a devDependency; whether it is importable here
    // is not the point — the contract is that this never throws, because the hash
    // and cloud backends must be able to run a prefetch/smoke check without it.
    const dir = await readRuntimeCacheDir();
    expect(dir === null || typeof dir === "string").toBe(true);
  });
});

describe("checkCachePathHeadroom", () => {
  it("never flags a risk on POSIX platforms — MAX_PATH is a Windows limit", () => {
    const deep = `/${"a".repeat(300)}`;
    const result = checkCachePathHeadroom(deep, "linux");
    expect(result.atRisk).toBe(false);
    expect(result.headroom).toBe(MAX_PATH_LIMIT - deep.length);
  });

  it("passes a short Windows cache root (the documented C:\\hf-cache mitigation)", () => {
    const result = checkCachePathHeadroom("C:\\hf-cache", "win32");
    expect(result.atRisk).toBe(false);
    expect(result.cacheRoot).toBe("C:\\hf-cache");
    expect(result.rootLength).toBe(11);
    expect(result.headroom).toBe(MAX_PATH_LIMIT - 11);
  });

  it("flags a deep Windows cache root that cannot fit the model subpath", () => {
    // A realistic node_modules-nested cache under a long user profile.
    const deep = `C:\\Users\\some.developer\\source\\repos\\${"nested\\".repeat(20)}.cache\\huggingface`;
    expect(deep.length).toBeGreaterThan(MAX_PATH_LIMIT - CACHE_SUFFIX_BUDGET);
    const result = checkCachePathHeadroom(deep, "win32");
    expect(result.atRisk).toBe(true);
  });

  it("flags the boundary: exactly one character less than the suffix budget", () => {
    const root = "C:\\" + "x".repeat(MAX_PATH_LIMIT - CACHE_SUFFIX_BUDGET);
    expect(checkCachePathHeadroom(root, "win32").atRisk).toBe(true);

    const justEnough = "C:\\" + "x".repeat(MAX_PATH_LIMIT - CACHE_SUFFIX_BUDGET - 3);
    expect(justEnough.length).toBe(MAX_PATH_LIMIT - CACHE_SUFFIX_BUDGET);
    expect(checkCachePathHeadroom(justEnough, "win32").atRisk).toBe(false);
  });

  it("flags an UNPINNED cache on Windows — the worst case, not a 260-char win", () => {
    const result = checkCachePathHeadroom(UNPINNED_CACHE, "win32");
    expect(result.atRisk).toBe(true);
    expect(result.cacheRoot).toBeNull();
    expect(result.rootLength).toBe(0);
  });

  it("does not flag an unpinned cache off Windows", () => {
    expect(checkCachePathHeadroom(UNPINNED_CACHE, "darwin").atRisk).toBe(false);
  });
});
