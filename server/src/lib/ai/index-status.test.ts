/**
 * #2326 — a project's index status: the six states the issue names (healthy,
 * never indexed, run in progress, last run failed, partial coverage, and —
 * in the route test — retrieval throws), the classified error, and that no
 * recorded error text ever reaches what the model or the UI is given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  project: null as { name: string } | null,
  connections: [] as Array<Record<string, unknown>>,
  graphs: [] as Array<Record<string, unknown>>,
  documents: [] as Array<{ filename: string }>,
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    project: { findUnique: vi.fn(async () => db.project) },
    repoConnection: { findMany: vi.fn(async () => db.connections) },
    codeGraph: { findMany: vi.fn(async () => db.graphs) },
    document: { findMany: vi.fn(async () => db.documents) },
  },
}));

import { INDEX_ERROR_CLASSES } from "@metis/shared";
import { codeAccessFilterOf } from "../analysis/tools/code-access.js";
import type { SourceIngestState } from "../connectors/source-ingest-state.js";
import {
  INDEX_STATUS_KEY,
  classifyIndexError,
  formatIndexStatus,
  indexStatusEnabled,
  indexStatusLine,
  loadProjectIndexStatus,
  readProjectIndexStatus,
  toGroundingIndex,
} from "./index-status.js";

const NOW = Date.parse("2026-11-12T06:00:00.000Z");
/** A credential-shaped, path-bearing error, as a failed clone records it. */
const SECRET_ERROR =
  "fatal: Authentication failed for 'https://x-access-token:ghp_SECRET1234567890abcdef@github.com/acme/app.git/' " +
  "(clone dir /var/lib/metis/clones/c1, DATABASE_URL=postgres://metis:hunter2@db.internal:5432/metis)";

function ingest(over: Partial<SourceIngestState> = {}): string {
  const state: SourceIngestState = {
    version: 1,
    runId: "r1",
    status: "completed",
    startedAt: "2026-11-12T05:00:00.000Z",
    heartbeatAt: "2026-11-12T05:10:00.000Z",
    finishedAt: "2026-11-12T05:10:00.000Z",
    eligible: 100,
    selected: 100,
    processed: 100,
    created: 90,
    updated: 5,
    unchanged: 5,
    failed: 0,
    chunkCount: 800,
    skipped: { cap: 0, tooLarge: 2, unreadable: 0, excludedTests: 7, excludedGenerated: 1 },
    limits: { maxFiles: 5000, maxFileBytes: 1_048_576, includeTests: false },
    ...over,
  };
  return JSON.stringify(state);
}

function repo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c1",
    label: "acme-app",
    status: "connected",
    errorMessage: null,
    lastIngestAt: new Date("2026-11-12T05:10:00.000Z"),
    lastCommitSha: "aaaaaaa1111111",
    sourceIngestState: ingest(),
    ...over,
  };
}

const graph = {
  repoConnectionId: "c1",
  commitSha: "c4d54f87abcdef",
  lastIndexedAt: new Date("2026-11-12T05:09:00.000Z"),
  symbolCount: 3533,
};

const load = (opts: Parameters<typeof loadProjectIndexStatus>[1] = {}) =>
  loadProjectIndexStatus("p1", { now: NOW, ingestActive: () => false, ...opts });

beforeEach(() => {
  db.project = { name: "Acme Reader" };
  db.connections = [repo()];
  db.graphs = [graph];
  db.documents = [{ filename: "manual.pdf" }, { filename: "connector:repo:c1:src/a.ts" }];
});

describe("classifyIndexError (#2326)", () => {
  it.each([
    ["ETIMEDOUT reading from the embedder", "timed out"],
    [SECRET_ERROR, "authentication failed"],
    ["HttpError: 404 Not Found", "repository not found"],
    ["connect ECONNREFUSED 10.0.0.4:443", "network error"],
    ["ENOSPC: no space left on device", "out of disk space or memory"],
    ["ACL actor unavailable", "access check failed"],
    ["onnxruntime session failed to load", "embedding model unavailable"],
    ["LanceError(IO): table not open", "vector index unavailable"],
    ["PrismaClientKnownRequestError P2024", "database error"],
    ["something odd", "unexpected error"],
  ])("%s → %s", (raw, cls) => {
    expect(classifyIndexError(raw)).toBe(cls);
    expect(classifyIndexError(new Error(raw))).toBe(cls);
  });

  it("only ever returns a phrase from the fixed vocabulary", () => {
    for (const raw of [SECRET_ERROR, "", undefined, 42, { message: "x" }]) {
      expect(INDEX_ERROR_CLASSES).toContain(classifyIndexError(raw));
    }
    const coded = Object.assign(new Error("boom"), { code: "ETIMEDOUT" });
    expect(classifyIndexError(coded)).toBe("timed out");
  });
});

describe("loadProjectIndexStatus (#2326)", () => {
  it("healthy: last commit and time, a completed run, counts and coverage", async () => {
    const s = (await load())!;
    expect(s.state).toBe("healthy");
    expect(s.documents).toBe(2);
    expect(s.repos).toEqual([
      {
        label: "acme-app",
        commitSha: "c4d54f87abcdef",
        indexedAt: "2026-11-12T05:09:00.000Z",
        lastRun: "completed",
        symbols: 3533,
        coverage: {
          eligible: 100,
          indexed: 100,
          failed: 0,
          skipped: { limit: 0, tooLarge: 2, unreadable: 0, policy: 8 },
        },
        inProgress: false,
      },
    ]);
    expect(indexStatusLine(s)).toBeNull();
  });

  it("never indexed: no run, no graph, no document", async () => {
    db.connections = [repo({ lastIngestAt: null, lastCommitSha: null, sourceIngestState: null })];
    db.graphs = [];
    db.documents = [];
    const s = (await load())!;
    expect(s.state).toBe("never-indexed");
    expect(s.repos[0]).toMatchObject({ lastRun: "never", commitSha: null, indexedAt: null });
    expect(indexStatusLine(s)).toMatch(/repository "acme-app" has never been indexed/);
  });

  it("never indexed: a project with no repository and no document", async () => {
    db.connections = [];
    db.graphs = [];
    db.documents = [];
    const s = (await load())!;
    expect(s.state).toBe("never-indexed");
    expect(indexStatusLine(s)).toMatch(/nothing in it has been indexed yet/);
    expect(formatIndexStatus(s)).toContain("No repository is connected.");
  });

  it("run in progress: a fresh running heartbeat, or a run holding the ingest lease", async () => {
    db.connections = [
      repo({
        sourceIngestState: ingest({
          status: "running",
          heartbeatAt: "2026-11-12T05:58:00.000Z",
          finishedAt: null,
        }),
      }),
    ];
    const running = (await load())!;
    expect(running.state).toBe("in-progress");
    expect(running.repos[0]).toMatchObject({ lastRun: "running", inProgress: true });
    expect(indexStatusLine(running)).toMatch(/"acme-app" is still being indexed/);

    db.connections = [repo()];
    const leased = (await load({ ingestActive: (id) => id === "c1" }))!;
    expect(leased.state).toBe("in-progress");
    expect(formatIndexStatus(leased)).toContain("a run is in progress");
  });

  it("last run failed: the error is classified, never quoted", async () => {
    db.connections = [
      repo({ sourceIngestState: ingest({ status: "failed", error: SECRET_ERROR }) }),
    ];
    const s = (await load())!;
    expect(s.state).toBe("failed");
    expect(s.repos[0]).toMatchObject({ lastRun: "failed", error: "authentication failed" });
    const shown = [indexStatusLine(s)!, formatIndexStatus(s), JSON.stringify(toGroundingIndex(s))];
    for (const text of shown) {
      expect(text).not.toMatch(/ghp_|hunter2|x-access-token|\/var\/lib|db\.internal|postgres:/);
    }
    expect(indexStatusLine(s)).toMatch(
      /the last indexing of repository "acme-app" failed \(authentication failed\)/,
    );
  });

  it("a connector in error (a failed clone or pull) counts as failed", async () => {
    db.connections = [repo({ status: "error", errorMessage: SECRET_ERROR })];
    const s = (await load())!;
    expect(s.state).toBe("failed");
    expect(s.repos[0]!.error).toBe("authentication failed");
  });

  it("partial coverage: files past the limit, unreadable or failed; or an interrupted run", async () => {
    db.connections = [
      repo({
        sourceIngestState: ingest({
          status: "partial",
          created: 50,
          updated: 0,
          unchanged: 0,
          failed: 3,
          skipped: { cap: 40, tooLarge: 0, unreadable: 7, excludedTests: 0 },
        }),
      }),
    ];
    const partial = (await load())!;
    expect(partial.state).toBe("partial");
    expect(indexStatusLine(partial)).toMatch(
      /the index of repository "acme-app" is partial: 50 of 100 source files indexed/,
    );
    expect(formatIndexStatus(partial)).toContain(
      "50 of 100 eligible source files indexed; 3 failed; skipped: 40 past the file limit, 0 too large, 7 unreadable, 0 by policy",
    );

    db.connections = [
      repo({
        sourceIngestState: ingest({
          status: "running",
          heartbeatAt: "2026-11-12T05:00:00.000Z",
          finishedAt: null,
        }),
      }),
    ];
    const interrupted = (await load())!;
    expect(interrupted.state).toBe("partial");
    expect(interrupted.repos[0]!.lastRun).toBe("interrupted");
    expect(indexStatusLine(interrupted)).toMatch(/was interrupted/);
  });

  it("an index recorded before #182 is not flagged", async () => {
    db.connections = [repo({ sourceIngestState: null })];
    const s = (await load())!;
    expect(s.repos[0]).toMatchObject({ lastRun: "unrecorded", coverage: null });
    expect(s.state).toBe("healthy");
    expect(formatIndexStatus(s)).toContain("coverage not recorded");
  });

  it("the worst repository decides the project's state, and the list is capped", async () => {
    db.connections = [
      repo({ id: "c1", label: "ok" }),
      repo({ id: "c2", label: "bad", sourceIngestState: ingest({ status: "failed" }) }),
      ...Array.from({ length: 11 }, (_, i) => repo({ id: `x${i}`, label: `r${i}` })),
    ];
    const s = (await load())!;
    expect(s.state).toBe("failed");
    expect(s.repos).toHaveLength(10);
    expect(s.moreRepos).toBe(3);
    expect(formatIndexStatus(s)).toContain("(3 more repositories not listed)");
    expect(indexStatusLine(s)).toMatch(/"bad" failed \(unexpected error\)/);
  });

  it("does not count a repository document hidden from the caller (#2243)", async () => {
    const access = codeAccessFilterOf([{ connectorId: "c1", path: "a.ts" }]);
    expect((await load({ access }))!.documents).toBe(1);
  });

  it("a project that is gone is null; an unreadable status is null, not a throw", async () => {
    db.project = null;
    await expect(load()).resolves.toBeNull();
    const { prisma } = await import("../prisma.js");
    vi.mocked(prisma.project.findUnique).mockRejectedValueOnce(new Error("db down"));
    await expect(readProjectIndexStatus("p1")).resolves.toBeNull();
  });
});

describe("toGroundingIndex (#2326)", () => {
  it("keeps what the label shows and drops the counts", async () => {
    db.connections = [
      repo({ sourceIngestState: ingest({ status: "failed", error: "ETIMEDOUT" }) }),
    ];
    expect(toGroundingIndex((await load())!)).toEqual({
      state: "failed",
      repos: [
        {
          label: "acme-app",
          commitSha: "c4d54f87abcdef",
          indexedAt: "2026-11-12T05:09:00.000Z",
          lastRun: "failed",
          error: "timed out",
        },
      ],
    });
    db.connections = [repo({ lastIngestAt: null, lastCommitSha: null, sourceIngestState: null })];
    db.graphs = [];
    expect(toGroundingIndex((await load())!).repos[0]).toEqual({
      label: "acme-app",
      lastRun: "never",
    });
  });
});

describe("CHAT_INDEX_STATUS (#2326)", () => {
  const saved = process.env[INDEX_STATUS_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[INDEX_STATUS_KEY];
    else process.env[INDEX_STATUS_KEY] = saved;
  });

  it("is on by default and an operator can turn it off", () => {
    delete process.env[INDEX_STATUS_KEY];
    expect(indexStatusEnabled()).toBe(true);
    process.env[INDEX_STATUS_KEY] = "false";
    expect(indexStatusEnabled()).toBe(false);
  });
});
