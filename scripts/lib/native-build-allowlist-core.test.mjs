import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  auditNativeAllowlist,
  lockedVersions,
  readOnlyBuiltDependencies,
} from "./native-build-allowlist-core.mjs";

const LOCK = [
  "lockfileVersion: '9.0'",
  "",
  "packages:",
  "",
  "  better-sqlite3@12.11.1:",
  "    resolution: {integrity: sha512-x}",
  "",
  "snapshots:",
  "",
  "  '@prisma/adapter-better-sqlite3@7.8.0':",
  "    dependencies:",
  "      better-sqlite3: 12.11.1",
  "",
  "  better-sqlite3@12.11.1:",
  "    dependencies:",
  "      bindings: 1.5.0",
  "      prebuild-install: 7.1.3",
  "",
  "  better-sqlite3@13.0.2:",
  "    dependencies:",
  "      node-addon-api: 8.9.1",
  "",
  "  bidi-js@1.0.3:",
  "    dependencies:",
  "      prebuild-install: 7.1.3",
  "",
].join("\n");

const WS = [
  "packages:",
  "  - server",
  "",
  "onlyBuiltDependencies:",
  '  - "@prisma/engines"',
  "  - better-sqlite3@12.11.1 # the one that fetches",
  "  - esbuild",
  "",
  "overrides:",
  "  foo: 1",
].join("\n");

describe("readOnlyBuiltDependencies", () => {
  it("reads the list, unquoted, stripping trailing comments, and stops at the next key", () => {
    expect(readOnlyBuiltDependencies(WS)).toEqual([
      "@prisma/engines",
      "better-sqlite3@12.11.1",
      "esbuild",
    ]);
  });
  it("returns nothing when the key is absent", () => {
    expect(readOnlyBuiltDependencies("packages:\n  - a\n")).toEqual([]);
  });
});

describe("lockedVersions", () => {
  it("reads each locked copy from snapshots and whether it runs prebuild-install", () => {
    expect(lockedVersions(LOCK, "better-sqlite3")).toEqual([
      { version: "12.11.1", fetchesBinary: true },
      { version: "13.0.2", fetchesBinary: false },
    ]);
  });
  it("does not attribute another package's prebuild-install to the previous copy", () => {
    const v = lockedVersions(LOCK, "better-sqlite3").find((x) => x.version === "13.0.2");
    expect(v?.fetchesBinary).toBe(false);
  });
  it("reads a quoted key, and skips peer-suffixed keys and look-alike names", () => {
    const lock = [
      "snapshots:",
      "  'better-sqlite3@11.0.0':",
      "    dependencies:",
      "      prebuild-install: 7.1.3",
      "  better-sqlite3@9.0.0(foo@1.0.0):",
      "    dependencies:",
      "      prebuild-install: 7.1.3",
      "  better-sqlite3-multiple-ciphers@12.0.0:",
      "    dependencies:",
      "      prebuild-install: 7.1.3",
      "  better-sqlite3@:",
      "",
    ].join("\n");
    expect(lockedVersions(lock, "better-sqlite3")).toEqual([
      { version: "11.0.0", fetchesBinary: true },
    ]);
  });

  it("returns nothing without a snapshots section", () => {
    expect(lockedVersions("packages:\n", "better-sqlite3")).toEqual([]);
  });
});

describe("auditNativeAllowlist", () => {
  const versions = lockedVersions(LOCK, "better-sqlite3");

  it("accepts the fetching copy at its exact version and nothing else", () => {
    expect(auditNativeAllowlist(["better-sqlite3@12.11.1"], versions, "better-sqlite3")).toEqual(
      [],
    );
  });

  it("rejects the bare name — the shape that broke Windows (#2)", () => {
    const p = auditNativeAllowlist(["better-sqlite3"], versions, "better-sqlite3");
    expect(p.join("\n")).toMatch(/bare name/);
    expect(p.join("\n")).toMatch(/12\.11\.1 fetches its binary .* not allowlisted/);
  });

  it("rejects allowlisting the copy that bundles its binaries", () => {
    const p = auditNativeAllowlist(
      ["better-sqlite3@12.11.1 || 13.0.2"],
      versions,
      "better-sqlite3",
    );
    expect(p).toEqual([expect.stringMatching(/13\.0\.2 bundles its binaries but is allowlisted/)]);
  });

  it("rejects a fetching copy left off the list (it would ship without a binary)", () => {
    expect(auditNativeAllowlist([], versions, "better-sqlite3")).toEqual([
      expect.stringMatching(/12\.11\.1 fetches its binary/),
    ]);
  });

  it("rejects a stale pinned version the lockfile no longer carries", () => {
    const p = auditNativeAllowlist(
      ["better-sqlite3@12.11.1", "better-sqlite3@12.9.0"],
      versions,
      "better-sqlite3",
    );
    expect(p).toEqual([expect.stringMatching(/12\.9\.0 is allowlisted but not in the lockfile/)]);
  });

  it("fails rather than passing when it read no locked version at all", () => {
    expect(auditNativeAllowlist(["better-sqlite3"], [], "better-sqlite3")).toEqual([
      expect.stringMatching(/no locked version found/),
    ]);
  });
});

describe("this repository (#2)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(root, rel), "utf8");

  it("allows install scripts for exactly the better-sqlite3 copies that need one", () => {
    const versions = lockedVersions(read("pnpm-lock.yaml"), "better-sqlite3");
    // Guard against a parser that silently reads nothing: the tree carries both.
    expect(versions.some((v) => v.fetchesBinary)).toBe(true);
    expect(versions.some((v) => !v.fetchesBinary)).toBe(true);
    expect(
      auditNativeAllowlist(
        readOnlyBuiltDependencies(read("pnpm-workspace.yaml")),
        versions,
        "better-sqlite3",
      ),
    ).toEqual([]);
  });
});
