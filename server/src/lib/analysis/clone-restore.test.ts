/** #1322 — the analysis pass restores a purged clone, and never offers a hollow one. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { ensureConnectorClone } from "../connectors/repo/clone-health.js";

const db = vi.hoisted(() => ({
  row: null as null | { provider: string },
  graphCommit: null as string | null,
  fail: false,
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    repoConnection: {
      findFirst: vi.fn(async () => {
        if (db.fail) throw new Error("db down");
        return db.row;
      }),
    },
    codeGraph: { findFirst: vi.fn(async () => ({ commitSha: db.graphCommit })) },
  },
}));

import { prisma } from "../prisma.js";
import { prepareAnalysisClone } from "./clone-restore.js";

const root = mkdtempSync(path.join(os.tmpdir(), "metis-1322-analysis-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SHA = "d".repeat(40);
let ensureClone: Mock<typeof ensureConnectorClone>;
let n = 0;
let id = "";

function withFiles(): void {
  mkdirSync(path.join(root, id, "src"), { recursive: true });
  writeFileSync(path.join(root, id, "src", "a.ts"), "x");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REPO_CLONE_DIR", root);
  n += 1;
  id = `conn-${n}`;
  db.row = { provider: "github" };
  db.graphCommit = SHA;
  db.fail = false;
  ensureClone = vi.fn<typeof ensureConnectorClone>(async () => ({
    status: "restored",
    path: "/x",
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("prepareAnalysisClone", () => {
  it("a git connector's clone is checked at the CODE GRAPH's commit (one source of truth)", async () => {
    ensureClone.mockResolvedValueOnce({ status: "healthy", path: "/x" });
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("healthy");
    const { loadCommitSha } = ensureClone.mock.calls[0]![0];
    expect(await loadCommitSha()).toBe(SHA);
    expect(prisma.codeGraph.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p", repoConnectionId: id } }),
    );
  });

  it("reports a restored clone as restored", async () => {
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("restored");
  });

  it("withholds the file tools when the clone cannot be made usable", async () => {
    ensureClone.mockResolvedValueOnce({ status: "unavailable", reason: "busy", state: "missing" });
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("unusable");
    ensureClone.mockRejectedValueOnce(new Error("boom"));
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("unusable");
  });

  it("local/upload or unknown connectors: what is on disk, only if it has files", async () => {
    db.row = { provider: "upload" };
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("unusable");
    mkdirSync(path.join(root, id, "empty", "dirs"), { recursive: true });
    db.row = null;
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("unusable");
    withFiles();
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("healthy");
    expect(ensureClone).not.toHaveBeenCalled();
  });

  it("a failed connector lookup falls back to what is on disk, never throws", async () => {
    db.fail = true;
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("unusable");
    withFiles();
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("healthy");
  });
});
