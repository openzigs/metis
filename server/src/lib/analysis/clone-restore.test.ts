/** #1322 — the analysis pass restores a purged clone, and never offers a hollow one. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { ensureConnectorClone } from "../connectors/repo/clone-health.js";

const connector = vi.hoisted(() => ({
  row: null as null | { provider: string; lastCommitSha: string | null },
  fail: false,
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    repoConnection: {
      findFirst: vi.fn(async () => {
        if (connector.fail) throw new Error("db down");
        return connector.row;
      }),
    },
  },
}));

import { prepareAnalysisClone } from "./clone-restore.js";

const root = mkdtempSync(path.join(os.tmpdir(), "metis-1322-analysis-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SHA = "d".repeat(40);
let ensureClone: Mock<typeof ensureConnectorClone>;
let n = 0;
let id = "";

beforeEach(() => {
  vi.stubEnv("REPO_CLONE_DIR", root);
  n += 1;
  id = `conn-${n}`;
  connector.row = { provider: "github", lastCommitSha: SHA };
  connector.fail = false;
  ensureClone = vi.fn<typeof ensureConnectorClone>(async () => ({
    status: "restored",
    path: "/x",
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("prepareAnalysisClone", () => {
  it("uses a clone with files as it is, without touching the database", async () => {
    mkdirSync(path.join(root, id, "src"), { recursive: true });
    writeFileSync(path.join(root, id, "src", "a.ts"), "x");
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("healthy");
    expect(ensureClone).not.toHaveBeenCalled();
  });

  it("restores a hollow clone at the connector's last ingested commit", async () => {
    mkdirSync(path.join(root, id, "src", "deep"), { recursive: true });
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("restored");
    expect(ensureClone).toHaveBeenCalledWith({ projectId: "p", connectorId: id, commitSha: SHA });
  });

  it("withholds the file tools when the clone cannot be restored", async () => {
    ensureClone.mockResolvedValueOnce({
      status: "unavailable",
      reason: "restore-failed",
      state: "missing",
    });
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("unusable");
  });

  it("withholds them for a local/upload connector or an unknown one", async () => {
    connector.row = { provider: "upload", lastCommitSha: null };
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("unusable");
    connector.row = null;
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("unusable");
    expect(ensureClone).not.toHaveBeenCalled();
  });

  it("degrades to no file tools, never throws, when the lookup fails", async () => {
    connector.fail = true;
    expect(await prepareAnalysisClone("p", id, { ensureClone })).toBe("unusable");
  });
});
