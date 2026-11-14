/**
 * #2338 — when an ingest fetches, keeps or deletes a connector's history, and
 * (#2484 review) how the refresh runs beside an ingest, how often a too-large
 * history is tried again, and what removes history no live connector or flag
 * accounts for.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  conn: null as { provider: string } | null,
  graph: null as { commitSha: string | null } | null,
  where: [] as unknown[],
  graphQueries: [] as unknown[],
  projectConnectors: [] as { id: string }[],
  live: [] as { id: string }[],
  findManyWhere: [] as unknown[],
}));
vi.mock("../../prisma.js", () => ({
  prisma: {
    repoConnection: {
      findFirst: vi.fn(async (q: { where: unknown }) => {
        db.where.push(q.where);
        return db.conn;
      }),
      findMany: vi.fn(async (q: { where: { projectId?: string } }) => {
        db.findManyWhere.push(q.where);
        return q.where.projectId ? db.projectConnectors : db.live;
      }),
    },
    codeGraph: {
      findFirst: vi.fn(async (q: { where: unknown }) => {
        db.where.push(q.where);
        db.graphQueries.push(q);
        return db.graph;
      }),
    },
  },
}));

import {
  __historyRefreshesInFlight,
  cancelConnectorHistoryRefresh,
  refreshConnectorHistory,
  removeProjectHistories,
  startConnectorHistoryHousekeeping,
  startConnectorHistoryRefresh,
  stopConnectorHistoryRefreshes,
  sweepConnectorHistories,
  TOO_LARGE_RETRY_MS,
  type HistoryRefreshDeps,
} from "./history-refresh.js";
import { resolveRepoHistoryPath, resolveRepoHistoryStatePath } from "./clone-path.js";
import type { HistoryFetchOutcome } from "./history-repo.js";

const SHA = "c".repeat(40);
const OTHER = "d".repeat(40);
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
const LIMITS = { windowDays: 365, maxBytes: 1000 };
const NOW = new Date("2026-01-03T00:00:00.000Z");
const ready = {
  status: "ready",
  commitSha: SHA,
  windowStart: "2025-01-01T00:00:00.000Z",
  windowDays: 365,
  fetchedAt: "2026-01-01T00:00:00.000Z",
  sizeBytes: 1,
};
const tooLarge = {
  status: "too_large",
  commitSha: SHA,
  fetchedAt: "2026-01-01T00:00:00.000Z",
  sizeBytes: 5000,
  maxBytes: 1000,
  windowDays: 365,
};
/** The tool on, the limits and the clock fixed. */
const on = (extra: HistoryRefreshDeps = {}): HistoryRefreshDeps => ({
  enabled: () => true,
  limits: async () => LIMITS,
  now: () => NOW,
  ...extra,
});
const readyOutcome: HistoryFetchOutcome = {
  status: "ready",
  sizeBytes: 1,
  windowStart: "x",
  prefetchedObjects: 2,
};

beforeEach(() => {
  db.conn = { provider: "github" };
  db.graph = { commitSha: SHA };
  db.where = [];
  db.graphQueries = [];
  db.projectConnectors = [];
  db.live = [];
  db.findManyWhere = [];
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

  it("fetches at the commit the newest graph records, reading both rows by project", async () => {
    const fetch = vi.fn(async () => readyOutcome);
    const out = await refreshConnectorHistory("p1", "new", on({ fetch }));
    expect(out.status).toBe("ready");
    expect(fetch).toHaveBeenCalledWith("p1", "new", SHA, undefined);
    expect(db.where).toEqual([
      { id: "new", projectId: "p1", deletedAt: null },
      { projectId: "p1", repoConnectionId: "new" },
    ]);
    // The same graph row `loadCodeVersions` reads, so the two never disagree.
    expect(db.graphQueries[0]).toMatchObject({ orderBy: { lastIndexedAt: "desc" } });
  });

  it("keeps a history already fetched at that commit and window", async () => {
    const fetch = vi.fn();
    await seed("same", ready);
    expect(await refreshConnectorHistory("p1", "same", on({ fetch }))).toEqual({
      status: "unchanged",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-fetches at the same commit when REPO_HISTORY_WINDOW_DAYS changed", async () => {
    const fetch = vi.fn(async () => readyOutcome);
    await seed("window", ready);
    await refreshConnectorHistory(
      "p1",
      "window",
      on({ fetch, limits: async () => ({ ...LIMITS, windowDays: 90 }) }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not download a too-large history again at a new commit while its cap and window hold", async () => {
    const fetch = vi.fn(async () => readyOutcome);
    await seed("big", { ...tooLarge, commitSha: OTHER }, false);
    expect(await refreshConnectorHistory("p1", "big", on({ fetch }))).toEqual({
      status: "unchanged",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tries a too-large history again once its cap or window changes, or the retry period passes", async () => {
    const fetch = vi.fn(async () => readyOutcome);
    await seed("big2", tooLarge, false);
    await refreshConnectorHistory(
      "p1",
      "big2",
      on({ fetch, limits: async () => ({ ...LIMITS, maxBytes: 9999 }) }),
    );
    await refreshConnectorHistory(
      "p1",
      "big2",
      on({ fetch, limits: async () => ({ ...LIMITS, windowDays: 30 }) }),
    );
    await refreshConnectorHistory(
      "p1",
      "big2",
      on({
        fetch,
        now: () => new Date(Date.parse(tooLarge.fetchedAt) + TOO_LARGE_RETRY_MS + 1),
      }),
    );
    // A record from before the window was kept has no windowDays: tried again.
    await seed("big-old", { ...tooLarge, windowDays: undefined }, false);
    await refreshConnectorHistory("p1", "big-old", on({ fetch }));
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("re-fetches a history at another commit, a failed one, or one whose repository is gone", async () => {
    const fetch = vi.fn(async () => ({ status: "failed" as const, reason: "x" }));
    await seed("moved", { ...ready, commitSha: OTHER });
    await seed("lost", ready, false);
    await seed("failed", {
      status: "failed",
      commitSha: SHA,
      fetchedAt: ready.fetchedAt,
      reason: "x",
    });
    for (const id of ["moved", "lost", "failed"]) {
      await refreshConnectorHistory("p1", id, on({ fetch }));
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fetches nothing for a local or uploaded source, a missing connector, or no indexed commit", async () => {
    const fetch = vi.fn();
    for (const provider of ["local", "upload"]) {
      db.conn = { provider };
      expect(await refreshConnectorHistory("p1", "x", on({ fetch }))).toEqual({
        status: "no_history_for_source",
      });
    }
    db.conn = null;
    expect((await refreshConnectorHistory("p1", "x", on({ fetch }))).status).toBe(
      "no_history_for_source",
    );
    db.conn = { provider: "github" };
    for (const graph of [null, { commitSha: null }, { commitSha: "HEAD" }]) {
      db.graph = graph;
      expect(await refreshConnectorHistory("p1", "x", on({ fetch }))).toEqual({
        status: "no_indexed_commit",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hands the ingest's signal to the fetch, and fetches nothing once it is aborted", async () => {
    const fetch = vi.fn(async () => readyOutcome);
    const live = new AbortController();
    await refreshConnectorHistory("p1", "sig", on({ fetch, signal: live.signal }));
    expect(fetch).toHaveBeenCalledWith("p1", "sig", SHA, live.signal);
    const gone = new AbortController();
    gone.abort();
    expect(await refreshConnectorHistory("p1", "sig2", on({ fetch, signal: gone.signal }))).toEqual(
      { status: "aborted" },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never throws: a fetch that throws is a failed outcome", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await refreshConnectorHistory("p1", "t", on({ fetch }))).toEqual({
      status: "failed",
      reason: "history refresh failed",
    });
  });
});

/** A fetch that waits until released (or aborted), recording what it was given. */
function gatedFetch() {
  const calls: { id: string; signal: AbortSignal | undefined }[] = [];
  let release: () => void = () => undefined;
  let gate = new Promise<void>((r) => (release = r));
  const fetch = vi.fn(async (_p: string, id: string, _sha: string, signal?: AbortSignal) => {
    calls.push({ id, signal });
    await Promise.race([
      gate,
      new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true })),
    ]);
    return signal?.aborted ? ({ status: "failed", reason: "aborted" } as const) : readyOutcome;
  });
  return {
    fetch,
    calls,
    open: () => {
      release();
      gate = new Promise<void>((r) => (release = r));
    },
  };
}

describe("startConnectorHistoryRefresh", () => {
  it("returns before the download ends, so the ingest goes on; one refresh per connector, one re-run for requests meanwhile", async () => {
    const g = gatedFetch();
    let settled = false;
    const first = startConnectorHistoryRefresh("p1", "bg", undefined, on({ fetch: g.fetch }));
    void first.then(() => (settled = true));
    await vi.waitFor(() => expect(g.calls).toHaveLength(1));
    expect(settled).toBe(false);
    expect(__historyRefreshesInFlight()).toBe(1);
    // Two more requests while it runs fold into ONE re-run.
    void startConnectorHistoryRefresh("p1", "bg", undefined, on({ fetch: g.fetch }));
    void startConnectorHistoryRefresh("p1", "bg", undefined, on({ fetch: g.fetch }));
    g.open();
    await vi.waitFor(() => expect(g.calls).toHaveLength(2));
    g.open();
    await first;
    expect(g.fetch).toHaveBeenCalledTimes(2);
    expect(__historyRefreshesInFlight()).toBe(0);
  });

  it("is stopped by the ingest's signal, by a cancel, and at shutdown", async () => {
    const g = gatedFetch();
    const ingest = new AbortController();
    const a = startConnectorHistoryRefresh("p1", "abort-a", ingest.signal, on({ fetch: g.fetch }));
    const b = startConnectorHistoryRefresh("p1", "abort-b", undefined, on({ fetch: g.fetch }));
    const c = startConnectorHistoryRefresh("p1", "abort-c", undefined, on({ fetch: g.fetch }));
    await vi.waitFor(() => expect(g.calls).toHaveLength(3));
    ingest.abort();
    await a;
    await cancelConnectorHistoryRefresh("abort-b");
    await b;
    await stopConnectorHistoryRefreshes();
    await c;
    expect(g.calls.every((x) => x.signal?.aborted)).toBe(true);
    expect(__historyRefreshesInFlight()).toBe(0);
  });

  it("never starts a download for an ingest already cancelled", async () => {
    const g = gatedFetch();
    const ingest = new AbortController();
    ingest.abort();
    await startConnectorHistoryRefresh("p1", "dead", ingest.signal, on({ fetch: g.fetch }));
    expect(g.fetch).not.toHaveBeenCalled();
  });
});

describe("removal", () => {
  it("removes the history of every connector of a deleted project", async () => {
    await seed("pa", ready);
    await seed("pb", tooLarge, false);
    db.projectConnectors = [{ id: "pa" }, { id: "pb" }];
    expect(await removeProjectHistories("p9")).toBe(2);
    expect(db.findManyWhere).toEqual([{ projectId: "p9" }]);
    for (const id of ["pa", "pb"]) {
      expect(await exists(resolveRepoHistoryPath(id))).toBe(false);
      expect(await exists(resolveRepoHistoryStatePath(id))).toBe(false);
    }
  });

  it("sweeps every history while the tool is off, and only unaccounted ones while it is on", async () => {
    // Only this test's entries in the clone root.
    for (const e of await fs.readdir(base)) {
      await fs.rm(path.join(base, e), { recursive: true, force: true });
    }
    await seed("keep", ready);
    await seed("orphan", ready);
    await seed("orphan-record", tooLarge, false);
    await fs.mkdir(path.join(base, "keep-clone"), { recursive: true }); // a clone: never touched
    db.live = [{ id: "keep" }];
    expect(await sweepConnectorHistories({ enabled: () => true })).toBe(2);
    expect(db.findManyWhere.at(-1)).toMatchObject({
      deletedAt: null,
      project: { deletedAt: null },
    });
    expect(await exists(resolveRepoHistoryPath("keep"))).toBe(true);
    expect(await exists(resolveRepoHistoryPath("orphan"))).toBe(false);
    expect(await exists(resolveRepoHistoryStatePath("orphan-record"))).toBe(false);
    expect(await sweepConnectorHistories({ enabled: () => false })).toBe(1);
    expect(await exists(resolveRepoHistoryPath("keep"))).toBe(false);
    expect(await exists(path.join(base, "keep-clone"))).toBe(true);
  });

  it("sweeps again whenever the flag changes, and on no other key", async () => {
    await seed("flagged", ready);
    const bus = new EventEmitter();
    startConnectorHistoryHousekeeping({ bus, enabled: () => false });
    // The boot sweep, with the tool off: it removed it.
    await vi.waitFor(async () =>
      expect(await exists(resolveRepoHistoryPath("flagged"))).toBe(false),
    );
    await seed("flagged", ready);
    bus.emit("config.changed", { key: "SOMETHING_ELSE" });
    await new Promise((r) => setTimeout(r, 50));
    expect(await exists(resolveRepoHistoryPath("flagged"))).toBe(true);
    bus.emit("config.changed", { key: "CHAT_CHANGE_HISTORY_TOOL" });
    await vi.waitFor(async () =>
      expect(await exists(resolveRepoHistoryPath("flagged"))).toBe(false),
    );
    expect(bus.listenerCount("config.changed")).toBe(1);
    startConnectorHistoryHousekeeping({ bus, enabled: () => false });
    expect(bus.listenerCount("config.changed")).toBe(1);
  });
});
