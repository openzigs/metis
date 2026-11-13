/**
 * #2243 — the pure half of the code-tool access filter: which file a repository
 * document names, and how hidden paths are matched. The database half (ACL
 * rules, shared audience, the tools themselves) is covered on real SQLite in
 * `tests/chat-code-tools-acl-2243.sqlite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  codeAccessFilterOf,
  hiddenSymbolIds,
  hiddenSymbolsFor,
  normalizeRepoPath,
  repoDocumentPath,
  UNRESTRICTED_CODE_ACCESS,
} from "./code-access.js";

describe("repoDocumentPath", () => {
  it("names the source file of a source unit", () => {
    expect(repoDocumentPath("connector:repo:rc1:src/server/a.ts")).toEqual({
      connectorId: "rc1",
      path: "server/a.ts",
    });
  });

  it("names the root file of a README or manifest unit", () => {
    expect(repoDocumentPath("connector:repo:rc1:README.md")).toEqual({
      connectorId: "rc1",
      path: "README.md",
    });
    expect(repoDocumentPath("connector:repo:rc1:package.json")).toEqual({
      connectorId: "rc1",
      path: "package.json",
    });
  });

  it("names no file for the synthetic overview, a non-repo document or a malformed name", () => {
    expect(repoDocumentPath("connector:repo:rc1:OVERVIEW.md")).toBeNull();
    expect(repoDocumentPath("connector:db:dc1:public.users.md")).toBeNull();
    expect(repoDocumentPath("notes.md")).toBeNull();
    expect(repoDocumentPath("connector:repo:rc1")).toBeNull();
    expect(repoDocumentPath("connector:repo::src/a.ts")).toBeNull();
    expect(repoDocumentPath("connector:repo:rc1:src/")).toBeNull();
    expect(repoDocumentPath("connector:repo:rc1:")).toBeNull();
  });
});

describe("normalizeRepoPath", () => {
  it("reduces every spelling of a path to its ingested form", () => {
    for (const p of [
      "src/a.ts",
      "./src/a.ts",
      "/src/a.ts",
      "src//a.ts",
      "src/x/../a.ts",
      "src\\a.ts",
    ]) {
      expect(normalizeRepoPath(p), p).toBe("src/a.ts");
    }
  });
});

describe("codeAccessFilterOf", () => {
  it("is the unrestricted filter when nothing is hidden", () => {
    expect(codeAccessFilterOf([])).toBe(UNRESTRICTED_CODE_ACCESS);
    expect(UNRESTRICTED_CODE_ACCESS.isHidden("rc1", "src/a.ts")).toBe(false);
    expect(UNRESTRICTED_CODE_ACCESS.hiddenPaths(null)).toEqual([]);
  });

  it("hides a path in its own repository only", () => {
    const f = codeAccessFilterOf([{ connectorId: "rc1", path: "src/a.ts" }]);
    expect(f.unrestricted).toBe(false);
    expect(f.isHidden("rc1", "src/a.ts")).toBe(true);
    expect(f.isHidden("rc2", "src/a.ts")).toBe(false);
    expect(f.isHidden("rc1", "src/b.ts")).toBe(false);
    expect(f.hiddenPaths("rc1")).toEqual(["src/a.ts"]);
    expect(f.hiddenPaths("rc2")).toEqual([]);
  });

  it("matches a graph with no repository against every repository", () => {
    const f = codeAccessFilterOf([
      { connectorId: "rc1", path: "src/a.ts" },
      { connectorId: "rc2", path: "src/b.ts" },
    ]);
    expect(f.hiddenPaths(null).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(f.isHidden(null, "src/b.ts")).toBe(true);
  });

  it("matches another spelling of a path, and a different case as a different file", () => {
    const f = codeAccessFilterOf([{ connectorId: "rc1", path: "src/Config.ts" }]);
    expect(f.isHidden("rc1", "./src//Config.ts")).toBe(true);
    // On a case-sensitive clone `src/config.ts` is another, unrestricted file.
    expect(f.isHidden("rc1", "src/config.ts")).toBe(false);
  });
});

describe("hiddenSymbolIds", () => {
  it("reads nothing when nothing is hidden", async () => {
    await expect(hiddenSymbolIds(UNRESTRICTED_CODE_ACCESS, "p1", ["s1"])).resolves.toEqual(
      new Set(),
    );
    const f = codeAccessFilterOf([{ connectorId: "rc1", path: "a.ts" }]);
    await expect(hiddenSymbolIds(f, "p1", [])).resolves.toEqual(new Set());
  });
});

// #2314 review — the fused block's check judges each hit on the file and
// repository its line lookup resolved: no symbol is read a second time.
describe("hiddenSymbolsFor", () => {
  const hits = [
    { symbolId: "s1", filePath: "src/secret.ts", repoConnectionId: "rc1" },
    { symbolId: "s2", filePath: "src/secret.ts", repoConnectionId: "rc2" },
    { symbolId: "s3", filePath: "src/secret.ts", repoConnectionId: null },
    { symbolId: "s4", filePath: "./src/secret.ts" },
    { symbolId: "s5", filePath: "src/open.ts", repoConnectionId: "rc1" },
  ];

  it("hides a hit in a hidden file of its own repository, or of any when its repository is unknown", async () => {
    const lookup = hiddenSymbolsFor(async () =>
      codeAccessFilterOf([{ connectorId: "rc1", path: "src/secret.ts" }]),
    );
    expect([...(await lookup(hits))].sort()).toEqual(["s1", "s3", "s4"]);
  });

  it("loads the filter once, and hides nothing when it is unrestricted", async () => {
    let loads = 0;
    const lookup = hiddenSymbolsFor(async () => {
      loads += 1;
      return UNRESTRICTED_CODE_ACCESS;
    });
    expect(await lookup(hits)).toEqual(new Set());
    await lookup(hits);
    expect(loads).toBe(1);
  });
});
