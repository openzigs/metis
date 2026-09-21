/**
 * Issue #288 — `local` provider path-allowlist guard.
 *
 * Proves: default-deny when LOCAL_SOURCE_ROOTS unset/empty; containment within
 * an allowed root; `..` traversal rejection; symlink-escape rejection; and that
 * a valid directory inside an allowed root is accepted with its realpath.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAllowedRoots,
  validateLocalSourcePath,
  LOCAL_SOURCE_ROOTS_ENV,
} from "../src/lib/connectors/repo/local-source.js";
import { ConnectorError } from "../src/lib/connectors/types.js";

let tmpRoot: string; // realpath'd
let allowedDir: string;
let outsideDir: string;

beforeEach(async () => {
  // macOS /tmp is a symlink to /private/tmp — realpath so containment is exact.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-local-test-")));
  allowedDir = path.join(tmpRoot, "allowed");
  outsideDir = path.join(tmpRoot, "outside");
  await fs.mkdir(path.join(allowedDir, "sub"), { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(allowedDir, "a.ts"), "export const a = 1;\n");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function envWith(roots: string[]): NodeJS.ProcessEnv {
  return { [LOCAL_SOURCE_ROOTS_ENV]: roots.join(path.delimiter) };
}

describe("getAllowedRoots", () => {
  it("returns [] when env unset (default deny)", () => {
    expect(getAllowedRoots({})).toEqual([]);
  });
  it("returns [] when env empty/whitespace (default deny)", () => {
    expect(getAllowedRoots({ [LOCAL_SOURCE_ROOTS_ENV]: "   " })).toEqual([]);
  });
  it("drops relative entries, keeps absolute", () => {
    const roots = getAllowedRoots(envWith([allowedDir, "relative/path"]));
    expect(roots).toEqual([allowedDir]);
  });
});

describe("validateLocalSourcePath", () => {
  it("DENIES when LOCAL_SOURCE_ROOTS is unset (opt-in by deployment)", async () => {
    await expect(validateLocalSourcePath(allowedDir, {})).rejects.toMatchObject({
      code: "LOCAL_SOURCE_DISABLED",
    });
  });

  it("accepts a directory inside an allowed root and returns its realpath", async () => {
    const res = await validateLocalSourcePath(allowedDir, envWith([tmpRoot]));
    expect(res.realPath).toBe(allowedDir);
    expect(res.root).toBe(tmpRoot);
  });

  it("accepts a nested directory inside an allowed root", async () => {
    const res = await validateLocalSourcePath(path.join(allowedDir, "sub"), envWith([allowedDir]));
    expect(res.realPath).toBe(path.join(allowedDir, "sub"));
  });

  it("rejects a `..` traversal that escapes the allowed root", async () => {
    // allowedDir is the only root; ../outside resolves out of it.
    const traversal = path.join(allowedDir, "..", "outside");
    await expect(validateLocalSourcePath(traversal, envWith([allowedDir]))).rejects.toMatchObject({
      code: "LOCAL_PATH_FORBIDDEN",
    });
  });

  it("rejects a sibling path that is a string-prefix but not contained", async () => {
    // Root `<tmp>/allowed`; `<tmp>/allowed-evil` shares the prefix but must NOT match.
    const evil = path.join(tmpRoot, "allowed-evil");
    await fs.mkdir(evil, { recursive: true });
    await expect(validateLocalSourcePath(evil, envWith([allowedDir]))).rejects.toMatchObject({
      code: "LOCAL_PATH_FORBIDDEN",
    });
  });

  it("rejects a SYMLINK whose target escapes the allowed root", async () => {
    // A symlink INSIDE the allowed root pointing OUTSIDE it must be rejected
    // because we realpath before the containment check.
    const link = path.join(allowedDir, "escape");
    await fs.symlink(outsideDir, link);
    await expect(validateLocalSourcePath(link, envWith([allowedDir]))).rejects.toMatchObject({
      code: "LOCAL_PATH_FORBIDDEN",
    });
  });

  it("rejects a non-existent path", async () => {
    await expect(
      validateLocalSourcePath(path.join(allowedDir, "nope"), envWith([allowedDir])),
    ).rejects.toMatchObject({ code: "LOCAL_PATH_INVALID" });
  });

  it("rejects a file (must be a directory)", async () => {
    await expect(
      validateLocalSourcePath(path.join(allowedDir, "a.ts"), envWith([allowedDir])),
    ).rejects.toMatchObject({ code: "LOCAL_PATH_INVALID" });
  });

  it("rejects a path containing a NUL byte", async () => {
    await expect(
      validateLocalSourcePath(`${allowedDir}\0evil`, envWith([allowedDir])),
    ).rejects.toBeInstanceOf(ConnectorError);
  });
});
