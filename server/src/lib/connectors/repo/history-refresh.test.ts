/**
 * #2338 — when an ingest fetches, keeps or deletes a connector's history.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  conn: null as { provider: string } | null,
  graph: null as { commitSha: string | null } | null,
  where: [] as unknown[],
}));
vi.mock("../../prisma.js", () => ({
  prisma: {
    repoConnection: {
      findFirst: vi.fn(async (q: { where: unknown }) => {
        db.where.push(q.where);
        return db.conn;
      }),
    },
    codeGraph: {
      findFirst: vi.fn(async (q: { where: unknown }) => {
        db.where.push(q.where);
        return db.graph;
      }),
    },
  },
}));

import { refreshConnectorHistory } from "./history-refresh.js";
import { resolveRepoHistoryPath, resolveRepoHistoryStatePath } from "./clone-path.js";

const SHA = "c".repeat(40);
const base = mkdtempSync(path.join(os.tmpdir(), "metis-2338-refresh-"));
const original = process.env.REPO_CLONE_DIR;
process.env.REPO_CLONE_DIR = base;
afterAll(() => {
  if (original === undefined) delete process.env.REPO_CLONE_DIR;
  else process.env.REPO_CLONE_DIR = original;
  rmSync(base, { recursive: true, force: true });
});

async function seed(id: string, state: Record<string, unknown> | null, repo = true): Promise<void> {
  if (repo) {
    await fs.mkdir(resolveRepoHistoryPath(id), { recursive: true });
    await fs.writeFile(path.join(resolveRepoHistoryPath(id), "HEAD"), "ref: refs/heads/main\n");
  }
  if (state) await fs.writeFile(resolveRepoHistoryStatePath(id), JSON.stringify(state));
}
const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false,
  );
const ready = {
  status: "ready",
  commitSha: SHA,
  windowStart: "2025-01-01T00:00:00.000Z",
  windowDays: 365,
  fetchedAt: "2026-01-01T00:00:00.000Z",
  sizeBytes: 1,
};

beforeEach(() => {
  db.conn = { provider: "github" };
  db.graph = { commitSha: SHA };
  db.where = [];
});

describe("refreshConnectorHistory", () => {
  it("deletes the history (repository and record) when the tool is off, and fetches nothing", async () => {
    await seed("off", ready);
    const fetch = vi.fn();
    expect(await refreshConnectorHistory("p1", "off", { enabled: () => false, fetch })).toEqual({
      status: "off",
    });
    expect(await exists(resolveRepoHistoryPath("off"))).toBe(false);
    expect(await exists(resolveRepoHistoryStatePath("off"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches at the commit the graph records, reading both rows by project", async () => {
    const fetch = vi.fn(async () => ({
      status: "ready" as const,
      sizeBytes: 1,
      windowStart: "x",
      prefetchedObjects: 2,
    }));
    const out = await refreshConnectorHistory("p1", "new", { enabled: () => true, fetch });
    expect(out.status).toBe("ready");
    expect(fetch).toHaveBeenCalledWith("p1", "new", SHA);
    expect(db.where).toEqual([
      { id: "new", projectId: "p1", deletedAt: null },
      { projectId: "p1", repoConnectionId: "new" },
    ]);
  });

  it("keeps a history already fetched (or found too large) at that commit", async () => {
    const fetch = vi.fn();
    await seed("same", ready);
    expect(await refreshConnectorHistory("p1", "same", { enabled: () => true, fetch })).toEqual({
      status: "unchanged",
    });
    await seed(
      "big",
      {
        status: "too_large",
        commitSha: SHA,
        fetchedAt: ready.fetchedAt,
        sizeBytes: 9,
        maxBytes: 1,
      },
      false,
    );
    expect(await refreshConnectorHistory("p1", "big", { enabled: () => true, fetch })).toEqual({
      status: "unchanged",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-fetches a history at another commit, a failed one, or one whose repository is gone", async () => {
    const fetch = vi.fn(async () => ({ status: "failed" as const, reason: "x" }));
    await seed("moved", { ...ready, commitSha: "d".repeat(40) });
    await seed("lost", ready, false);
    await seed("failed", {
      status: "failed",
      commitSha: SHA,
      fetchedAt: ready.fetchedAt,
      reason: "x",
    });
    for (const id of ["moved", "lost", "failed"]) {
      await refreshConnectorHistory("p1", id, { enabled: () => true, fetch });
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fetches nothing for a local or uploaded source, a missing connector, or no indexed commit", async () => {
    const fetch = vi.fn();
    for (const provider of ["local", "upload"]) {
      db.conn = { provider };
      expect(await refreshConnectorHistory("p1", "x", { enabled: () => true, fetch })).toEqual({
        status: "no_history_for_source",
      });
    }
    db.conn = null;
    expect((await refreshConnectorHistory("p1", "x", { enabled: () => true, fetch })).status).toBe(
      "no_history_for_source",
    );
    db.conn = { provider: "github" };
    for (const graph of [null, { commitSha: null }, { commitSha: "HEAD" }]) {
      db.graph = graph;
      expect(await refreshConnectorHistory("p1", "x", { enabled: () => true, fetch })).toEqual({
        status: "no_indexed_commit",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never throws: a fetch that throws is a failed outcome", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await refreshConnectorHistory("p1", "t", { enabled: () => true, fetch })).toEqual({
      status: "failed",
      reason: "history refresh failed",
    });
  });
});
