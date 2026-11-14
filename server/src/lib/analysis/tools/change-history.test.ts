/**
 * #2338 — `get_change_history`'s arguments, access checks, unavailable
 * reasons and formatting, with the git side stubbed. The real-git walk is
 * covered by `connectors/repo/history-repo.test.ts`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  repoFindMany: vi.fn(async (_q: unknown) => [] as unknown[]),
  docFindFirst: vi.fn(async (_q: unknown) => null as unknown),
  symFindFirst: vi.fn(async (_q: unknown) => null as unknown),
  symFindMany: vi.fn(async (_q: unknown) => [] as unknown[]),
}));
vi.mock("../../prisma.js", () => ({
  prisma: {
    repoConnection: { findMany: db.repoFindMany },
    document: { findFirst: db.docFindFirst },
    codeSymbol: { findFirst: db.symFindFirst, findMany: db.symFindMany },
  },
}));

import {
  checkHistoryPath,
  createChangeHistoryTool,
  HISTORY_PAGE_SIZE,
  MAX_HISTORY_CURSOR,
  parseChangeHistoryArgs,
  type ChangeHistoryDeps,
  type HistoryRepo,
  type SymbolHit,
} from "./change-history.js";
import { codeAccessFilterOf } from "./code-access.js";
import { codeVersionIndexOf } from "../../code-graph/code-version.js";
import type { HistoryState } from "../../connectors/repo/history-repo.js";
import type { HistoryCommit, HistoryQuery } from "../../connectors/repo/history-log.js";

const SHA = "1".repeat(40);
const C1 = "a".repeat(40);
const C2 = "b".repeat(40);
const tmp = mkdtempSync(path.join(os.tmpdir(), "metis-2338-tool-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const gh: HistoryRepo = {
  id: "r1",
  label: "server",
  provider: "github",
  ownerOrOrg: "acme",
  repoName: "reader",
  apiBaseUrl: null,
};
const READY: HistoryState = {
  status: "ready",
  commitSha: SHA,
  windowStart: "2025-10-01T00:00:00.000Z",
  windowDays: 365,
  fetchedAt: "2026-10-02T00:00:00.000Z",
  sizeBytes: 10,
};
const commit = (sha: string, subject: string, body = "", author = "Ann"): HistoryCommit => ({
  sha,
  parents: [],
  committedAt: "2026-02-14T00:25:15.000Z",
  authorName: author,
  subject,
  body,
});

interface Setup extends ChangeHistoryDeps {
  repos?: HistoryRepo[];
  indexed?: string[];
  state?: HistoryState | null;
  commits?: HistoryCommit[];
  more?: "cap" | "bound" | "none";
}

function make(s: Setup = {}): {
  tool: ReturnType<typeof createChangeHistoryTool>;
  queries: HistoryQuery[];
} {
  const queries: HistoryQuery[] = [];
  const repos = s.repos ?? [gh];
  const dir = path.join(tmp, "plain.git");
  mkdirSync(dir, { recursive: true });
  const tool = createChangeHistoryTool({
    listRepos: async () => repos,
    isIndexedFile: async (_p, _r, f) => (s.indexed ?? ["src/feed.go"]).includes(f),
    findSymbols: async () => [],
    loadVersions: async () =>
      codeVersionIndexOf(repos.map((r) => ({ repoConnectionId: r.id, commitSha: SHA, repo: r }))),
    readState: async () => (s.state === undefined ? READY : s.state),
    historyDir: () => dir,
    // `cat-file -t`: every path is a blob.
    run: async () => ({ code: 0, stdout: "blob\n", stderr: "", stopped: null }),
    readLog: async (q) => {
      queries.push(q);
      return {
        ok: true,
        commits: s.commits ?? [commit(C1, "feat: add it")],
        more: s.more ?? "none",
        reached: null,
      };
    },
    ...s,
  });
  return { tool, queries };
}

const ctx = { projectId: "p1" };

describe("parseChangeHistoryArgs", () => {
  it("needs a file or a symbol, and names what arrived", () => {
    const r = parseChangeHistoryArgs({ path: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.result.content).toMatch(/requires "filePath".*received keys: \[path\]/);
  });

  it("validates the line range and the cursor", () => {
    expect(parseChangeHistoryArgs({ filePath: "a.go", startLine: 5 })).toEqual({
      ok: true,
      filePath: "a.go",
      lines: { start: 5, end: 5 },
      cursor: 0,
    });
    expect(parseChangeHistoryArgs({ filePath: "a.go", endLine: 7 })).toMatchObject({
      lines: { start: 7, end: 7 },
    });
    for (const bad of [
      { filePath: "a.go", startLine: 0 },
      { filePath: "a.go", startLine: 1.5, endLine: 2 },
      { filePath: "a.go", startLine: "3", endLine: 4 },
      { filePath: "a.go", startLine: 9, endLine: 2 },
      { filePath: "a.go", cursor: -1 },
      { filePath: "a.go", cursor: "20" },
      { filePath: "a.go", cursor: MAX_HISTORY_CURSOR + 1 },
      { symbol: "x\u0000y" },
      { symbol: "s".repeat(301) },
    ]) {
      expect(parseChangeHistoryArgs(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseChangeHistoryArgs({ symbol: " Feed.Refresh ", cursor: 20 })).toEqual({
      ok: true,
      symbol: "Feed.Refresh",
      cursor: 20,
    });
  });

  it("accepts only a repository-relative file path", () => {
    expect(checkHistoryPath("./src//feed.go")).toEqual({ ok: true, value: "src/feed.go" });
    for (const bad of [
      "/etc/passwd",
      "../x",
      "a/../../x",
      "C:/x",
      "a\\b",
      "-n1",
      ":(glob)*",
      "a\nb",
      "src/",
      ".",
      "~/x",
    ]) {
      expect(checkHistoryPath(bad).ok, bad).toBe(false);
    }
  });
});

describe("get_change_history", () => {
  it("bounds the walk by the cut commits the fetch recorded", async () => {
    const cut = "9".repeat(40);
    const { tool, queries } = make({ state: { ...READY, cuts: [cut] } });
    await tool.execute({ filePath: "src/feed.go" }, ctx);
    expect(queries[0]!.cuts).toEqual([cut]);
  });

  it("lists commits newest first with a commit link, the version line and the coverage line", async () => {
    const { tool, queries } = make({
      commits: [
        commit(C1, "feat(feed): add ignore_entry_updates", "Keeps edits made by AI summarizers."),
        commit(C2, "fix"),
      ],
      more: "none",
    });
    const r = await tool.execute({ filePath: "src/feed.go" }, ctx);
    expect(queries[0]).toMatchObject({
      commitSha: SHA,
      path: "src/feed.go",
      windowStart: READY.windowStart,
      skip: 0,
      cap: HISTORY_PAGE_SIZE,
    });
    expect(queries[0]!.lines).toBeUndefined();
    expect(queries[0]!.cuts).toBeNull(); // a record with no cuts: the whole walk
    const lines = r.content.split("\n");
    expect(lines[0]).toBe(
      "Change history of src/feed.go in server, newest first, walking back from the indexed " +
        "commit 111111111111. Window: commits committed since 2025-10-01.",
    );
    expect(lines[1]).toBe("Code version: indexed commit 111111111111.");
    expect(r.content).toContain(
      `1. ${C1} — committed 2026-02-14 — feat(feed): add ignore_entry_updates`,
    );
    expect(r.content).toContain("   | Keeps edits made by AI summarizers.");
    expect(r.content).toContain(`   Link: https://github.com/acme/reader/commit/${C1}`);
    expect(r.content).toContain(`2. ${C2} — committed`);
    expect(lines.at(-1)).toBe(
      "[more: none — this is the whole history: it starts inside the window (since 2025-10-01).]",
    );
    expect(r).toMatchObject({ resultCount: 2, truncated: false });
    expect(r.citations).toEqual([
      expect.objectContaining({
        repoConnectionId: "r1",
        path: "src/feed.go",
        startLine: null,
        commitSha: SHA,
        permalink: `https://github.com/acme/reader/blob/${SHA}/src/feed.go`,
        truncated: false,
      }),
    ]);
  });

  it("gives the cursor for the next page when capped", async () => {
    const { tool, queries } = make({ more: "cap", commits: [commit(C1, "x"), commit(C2, "y")] });
    const r = await tool.execute({ filePath: "src/feed.go", cursor: 20 }, ctx);
    expect(queries[0]!.skip).toBe(20);
    expect(r.content).toContain(`21. ${C1}`);
    expect(r.content).toContain(
      "[more: cap — commits 21-22 shown; older commits exist. Call again with cursor: 22",
    );
    expect(r.truncated).toBe(true);
    expect(r.citations?.[0]?.truncated).toBe(true);
  });

  it("offers no cursor when the walk stopped on its output limit, since it could never advance (#2484 panel)", async () => {
    const { tool } = make({
      readLog: async () => ({
        ok: true,
        commits: [commit(C1, "x")],
        more: "cap",
        reached: null,
        outputLimited: true,
      }),
    });
    const r = await tool.execute({ filePath: "src/feed.go" }, ctx);
    expect(r.content).not.toContain("cursor:");
    expect(r.content).toContain("older commits inside the window may exist but cannot be listed");
    expect(r.truncated).toBe(true);
  });

  it("never returns a bare empty list: no commits in the window says the bound", async () => {
    const { tool } = make({ commits: [], more: "bound" });
    const r = await tool.execute({ filePath: "src/feed.go" }, ctx);
    expect(r.resultCount).toBe(0);
    expect(r.content).toContain("No commit inside the window (since 2025-10-01) changed it.");
    expect(r.content).toContain(
      "[more: bound — no history before 2025-10-01 is available to this tool; the file may have changed before then.]",
    );
  });

  it("passes a line range through", async () => {
    const { tool, queries } = make();
    const r = await tool.execute({ filePath: "src/feed.go", startLine: 3, endLine: 9 }, ctx);
    expect(queries[0]!.lines).toEqual({ start: 3, end: 9 });
    expect(r.content).toContain("src/feed.go, lines 3-9");
    expect(r.citations?.[0]).toMatchObject({ startLine: 3, endLine: 9 });
  });

  it("redacts secrets and e-mail addresses in subject, body and author, and drops trailers", async () => {
    const { tool } = make({
      commits: [
        commit(
          C1,
          "rotate ghp_0123456789abcdefghijABCDEFGHIJ012345",
          "Reported by carol@example.com\nAKIAIOSFODNN7EXAMPLE was committed\nSigned-off-by: Dan <dan@example.com>\nCo-authored-by: Eve <eve@example.com>",
          "Frank frank@example.com",
        ),
      ],
    });
    const r = await tool.execute({ filePath: "src/feed.go" }, ctx);
    expect(r.content).not.toMatch(
      /@example\.com|ghp_0123|AKIAIOSFODNN7EXAMPLE|Signed-off-by|Co-authored-by/,
    );
    expect(r.content).toContain("[REDACTED:email]");
    expect(r.content).toContain("Author: Frank [REDACTED:email]");
  });

  it("cuts a long body to an excerpt", async () => {
    const { tool } = make({ commits: [commit(C1, "s", "word ".repeat(200))] });
    const r = await tool.execute({ filePath: "src/feed.go" }, ctx);
    expect(r.content).toMatch(/word …|word…/);
    expect(r.content.length).toBeLessThan(1500);
  });

  it("links GitLab commits under /-/commit and gives no link for another host type", async () => {
    const gl = { ...gh, provider: "gitlab", apiBaseUrl: "https://gitlab.acme.test/api/v4" };
    let r = await make({ repos: [gl] }).tool.execute({ filePath: "src/feed.go" }, ctx);
    expect(r.content).toContain(`Link: https://gitlab.acme.test/acme/reader/-/commit/${C1}`);
    const odd = { ...gh, provider: "bitbucket" };
    r = await make({ repos: [odd] }).tool.execute({ filePath: "src/feed.go" }, ctx);
    expect(r.content).toContain("Link: (no link for this repository type)");
  });

  describe("history unavailable — said explicitly, never as an empty history", () => {
    it("no_history_for_source for a local or uploaded source", async () => {
      for (const provider of ["local", "upload"]) {
        const r = await make({ repos: [{ ...gh, provider }] }).tool.execute(
          { filePath: "src/feed.go" },
          ctx,
        );
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(
          /^History unavailable \(no_history_for_source\) for src\/feed.go/,
        );
        expect(r.content).toContain("do not answer as if it never did");
      }
    });

    it("history_not_fetched with no state, a failed fetch, or history for another commit", async () => {
      for (const state of [
        null,
        { status: "failed", commitSha: SHA, fetchedAt: READY.fetchedAt, reason: "x" } as const,
        { ...READY, commitSha: "2".repeat(40) },
      ]) {
        const r = await make({ state }).tool.execute({ filePath: "src/feed.go" }, ctx);
        expect(r.content).toMatch(/^History unavailable \(history_not_fetched\)/);
      }
    });

    it("history_not_fetched when the index records no commit", async () => {
      const r = await make({
        loadVersions: async () =>
          codeVersionIndexOf([{ repoConnectionId: "r1", commitSha: null, repo: gh }]),
      }).tool.execute({ filePath: "src/feed.go" }, ctx);
      expect(r.content).toMatch(/^History unavailable \(history_not_fetched\)/);
    });

    it("history_too_large over the cap", async () => {
      const r = await make({
        state: {
          status: "too_large",
          commitSha: SHA,
          fetchedAt: READY.fetchedAt,
          sizeBytes: 9,
          maxBytes: 1,
        },
      }).tool.execute({ filePath: "src/feed.go" }, ctx);
      expect(r.content).toMatch(/^History unavailable \(history_too_large\)/);
    });

    it("refuses to read a shallow repository", async () => {
      const shallow = path.join(tmp, "shallow.git");
      mkdirSync(shallow, { recursive: true });
      writeFileSync(path.join(shallow, "shallow"), "x\n");
      const { tool, queries } = make({ historyDir: () => shallow });
      const r = await tool.execute({ filePath: "src/feed.go" }, ctx);
      expect(r.content).toMatch(/^History unavailable \(history_not_fetched\)/);
      expect(queries).toHaveLength(0);
    });
  });

  describe("access", () => {
    it("gives a hidden file, a credential file and an unindexed file the same reply as a missing one", async () => {
      const hidden = codeAccessFilterOf([{ connectorId: "r1", path: "src/feed.go" }]);
      const { tool, queries } = make({ indexed: ["src/feed.go", ".env"] });
      const missing = await tool.execute({ filePath: "src/nope.go" }, ctx);
      expect(missing).toEqual({
        content: "Error: File not found or not accessible: src/nope.go",
        isError: true,
      });
      const r = await tool.execute({ filePath: "src/feed.go" }, { ...ctx, codeAccess: hidden });
      expect(r).toEqual({
        content: "Error: File not found or not accessible: src/feed.go",
        isError: true,
      });
      const env = await tool.execute({ filePath: ".env" }, ctx);
      expect(env.content).toBe("Error: File not found or not accessible: .env");
      expect(queries).toHaveLength(0);
    });

    it("falls through to the next repository that knows the file, and only to one the caller may read", async () => {
      const r2 = { ...gh, id: "r2", label: "client" };
      const hidden = codeAccessFilterOf([{ connectorId: "r1", path: "src/feed.go" }]);
      const { tool, queries } = make({ repos: [gh, r2] });
      const r = await tool.execute({ filePath: "src/feed.go" }, { ...ctx, codeAccess: hidden });
      expect(r.content).toContain("in client");
      expect(r.citations?.[0]?.repoConnectionId).toBe("r2");
      expect(queries).toHaveLength(1);
    });

    it("refuses a file that is not at the indexed commit", async () => {
      const { tool, queries } = make({
        run: async () => ({ code: 128, stdout: "", stderr: "fatal: path", stopped: null }),
      });
      const r = await tool.execute({ filePath: "src/feed.go" }, ctx);
      expect(r.content).toBe("Error: File not found or not accessible: src/feed.go");
      expect(queries).toHaveLength(0);
    });

    it("needs a project-scoped session", async () => {
      const r = await make().tool.execute({ filePath: "src/feed.go" }, { projectId: "" });
      expect(r).toMatchObject({ isError: true });
    });
  });

  describe("symbols", () => {
    const hit = (over: Partial<SymbolHit> = {}): SymbolHit => ({
      repoId: "r1",
      qualifiedName: "src/feed.go::Feed::Refresh",
      kind: "method",
      filePath: "src/feed.go",
      startLine: 10,
      endLine: 30,
      ...over,
    });

    it("resolves one symbol to its file and lines at the indexed commit", async () => {
      const { tool, queries } = make({ findSymbols: async () => [hit()] });
      const r = await tool.execute({ symbol: "Refresh" }, ctx);
      expect(queries[0]).toMatchObject({ path: "src/feed.go", lines: { start: 10, end: 30 } });
      expect(r.content).toContain("src/feed.go::Feed::Refresh (src/feed.go, lines 10-30)");
    });

    it("returns the candidates of an ambiguous name instead of guessing", async () => {
      const { tool, queries } = make({
        findSymbols: async () => [
          hit(),
          hit({ qualifiedName: "src/user.go::User::Refresh", filePath: "src/user.go" }),
        ],
      });
      const r = await tool.execute({ symbol: "Refresh" }, ctx);
      expect(r).toMatchObject({ resultCount: 0, zeroResultKind: "ambiguous-name" });
      expect(r.content).toContain("- src/user.go::User::Refresh (method) src/user.go:10-30");
      expect(queries).toHaveLength(0);
    });

    it("filters hidden symbols BEFORE the candidate limit, so they cannot push a visible one out (#2484 review)", async () => {
      // Eleven same-named symbols in a hidden file sort first; the visible one is twelfth.
      const row = (filePath: string, i: number) => ({
        qualifiedName: `${filePath}::Refresh${String(i).padStart(2, "0")}`,
        kind: "method",
        filePath,
        startLine: 10,
        endLine: 30,
        graph: { repoConnectionId: "r1" },
      });
      const rows = [
        ...Array.from({ length: 11 }, (_, i) => row("src/secret.go", i)),
        row("src/feed.go", 99),
      ];
      db.symFindMany.mockImplementation(async (q: unknown) => {
        const { skip = 0, take = rows.length } = q as { skip?: number; take?: number };
        return rows.slice(skip, skip + take);
      });
      const hidden = codeAccessFilterOf([{ connectorId: "r1", path: "src/secret.go" }]);
      const { tool, queries } = make({ findSymbols: undefined });
      const r = await tool.execute({ symbol: "Refresh" }, { ...ctx, codeAccess: hidden });
      expect(r.content).not.toMatch(/^No indexed symbol/);
      expect(queries[0]).toMatchObject({ path: "src/feed.go", lines: { start: 10, end: 30 } });
      db.symFindMany.mockReset();
      db.symFindMany.mockImplementation(async () => []);
    });

    it("hides a symbol in a file the caller may not read, and says when none is found", async () => {
      const hidden = codeAccessFilterOf([{ connectorId: "r1", path: "src/feed.go" }]);
      const { tool } = make({ findSymbols: async () => [hit(), hit({ repoId: "elsewhere" })] });
      const r = await tool.execute({ symbol: "Refresh" }, { ...ctx, codeAccess: hidden });
      expect(r).toMatchObject({ resultCount: 0 });
      expect(r.content).toMatch(/^No indexed symbol is named Refresh/);
    });
  });

  describe("read failures", () => {
    it("says a failed or slow read says nothing about the file", async () => {
      for (const reason of ["timeout", "failed"] as const) {
        const r = await make({ readLog: async () => ({ ok: false, reason }) }).tool.execute(
          { filePath: "src/feed.go" },
          ctx,
        );
        expect(r.isError).toBe(true);
        expect(r.content).toContain("This says nothing about whether the file changed.");
      }
    });

    it("reports a range past the end of the file as a bad argument", async () => {
      const r = await make({
        readLog: async () => ({ ok: false, reason: "line-range" }),
      }).tool.execute({ filePath: "src/feed.go", startLine: 900 }, ctx);
      expect(r.content).toMatch(/refused "startLine\/endLine" because the range is past the end/);
    });
  });
});

describe("default lookups — scoped to the session's project (A01)", () => {
  const SYM = {
    qualifiedName: "src/feed.go::Refresh",
    kind: "function",
    filePath: "src/feed.go",
    startLine: 4,
    endLine: 8,
  };
  const deps = (queries: HistoryQuery[] = []): ChangeHistoryDeps => ({
    loadVersions: async () =>
      codeVersionIndexOf([{ repoConnectionId: "r1", commitSha: SHA, repo: gh }]),
    readState: async () => READY,
    historyDir: () => path.join(tmp, "plain.git"),
    run: async () => ({ code: 0, stdout: "blob\n", stderr: "", stopped: null }),
    readLog: async (q) => {
      queries.push(q);
      return { ok: true, commits: [], more: "bound", reached: null };
    },
  });

  it("reads connections and symbols by project, never by id alone", async () => {
    db.repoFindMany.mockResolvedValueOnce([gh]);
    db.symFindMany.mockResolvedValueOnce([
      { ...SYM, graph: { repoConnectionId: "r1" } },
      { ...SYM, qualifiedName: "legacy", graph: { repoConnectionId: null } },
    ]);
    const queries: HistoryQuery[] = [];
    const r = await createChangeHistoryTool(deps(queries)).execute({ symbol: "Refresh" }, ctx);
    expect(r.content).toContain("src/feed.go::Refresh (src/feed.go, lines 4-8)");
    expect(db.repoFindMany.mock.calls[0]![0]).toMatchObject({
      where: { projectId: "p1", deletedAt: null },
    });
    expect(db.symFindMany.mock.calls[0]![0]).toMatchObject({
      where: {
        projectId: "p1",
        OR: [{ qualifiedName: "Refresh" }, { name: "Refresh" }],
        graph: { projectId: "p1", repoConnectionId: { in: ["r1"] } },
      },
    });
    expect(queries).toHaveLength(1);
  });

  it("knows a file by its source document or by a symbol in the connection's graph", async () => {
    const tool = createChangeHistoryTool(deps());
    db.repoFindMany.mockResolvedValue([gh]);
    db.docFindFirst.mockResolvedValueOnce({ id: "d1" });
    expect((await tool.execute({ filePath: "src/feed.go" }, ctx)).isError).toBeUndefined();
    expect(db.docFindFirst.mock.calls.at(-1)![0]).toMatchObject({
      where: { projectId: "p1", filename: { in: ["connector:repo:r1:src/src/feed.go"] } },
    });
    // #2484 panel — a root manifest the metadata ingest stored under its bare name.
    db.docFindFirst.mockResolvedValueOnce({ id: "d2" });
    expect((await tool.execute({ filePath: "go.mod" }, ctx)).isError).toBeUndefined();
    expect(db.docFindFirst.mock.calls.at(-1)![0]).toMatchObject({
      where: {
        projectId: "p1",
        filename: { in: ["connector:repo:r1:src/go.mod", "connector:repo:r1:go.mod"] },
      },
    });
    db.docFindFirst.mockResolvedValueOnce(null);
    db.symFindFirst.mockResolvedValueOnce({ id: "s1" });
    expect((await tool.execute({ filePath: "src/feed.go" }, ctx)).isError).toBeUndefined();
    expect(db.symFindFirst.mock.calls.at(-1)![0]).toMatchObject({
      where: {
        projectId: "p1",
        filePath: "src/feed.go",
        graph: { projectId: "p1", repoConnectionId: "r1" },
      },
    });
    db.docFindFirst.mockResolvedValueOnce(null);
    db.symFindFirst.mockResolvedValueOnce(null);
    expect((await tool.execute({ filePath: "src/feed.go" }, ctx)).content).toBe(
      "Error: File not found or not accessible: src/feed.go",
    );
    db.repoFindMany.mockReset();
  });
});
