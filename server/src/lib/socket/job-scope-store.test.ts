/**
 * #674 — the durable job-scope record behind `subscribe:job` for row-less jobs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { jobScopeRecord } = vi.hoisted(() => ({
  jobScopeRecord: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    findFirst: vi.fn(),
  },
}));
vi.mock("../prisma.js", () => ({ prisma: { jobScopeRecord } }));

import { JOB_SCOPE_TTL_MS, readJobScope, recordJobScope } from "./job-scope-store.js";
import { _resetJobLifecycleMemory, getJobScope } from "./job-events.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  _resetJobLifecycleMemory();
  jobScopeRecord.upsert.mockResolvedValue({});
  jobScopeRecord.deleteMany.mockResolvedValue({ count: 0 });
  jobScopeRecord.findFirst.mockResolvedValue(null);
});

describe("recordJobScope", () => {
  it("persists the scope with a TTL and remembers it in this process", async () => {
    await recordJobScope("job-1", "repo-ingest", "p1", NOW);
    const expiresAt = new Date(NOW.getTime() + JOB_SCOPE_TTL_MS);
    expect(jobScopeRecord.upsert).toHaveBeenCalledWith({
      where: { jobId: "job-1" },
      create: { jobId: "job-1", kind: "repo-ingest", projectId: "p1", expiresAt },
      update: { kind: "repo-ingest", projectId: "p1", expiresAt },
    });
    expect(getJobScope("job-1")).toEqual({ kind: "repo-ingest", projectId: "p1" });
  });

  it("prunes records that lapsed before now", async () => {
    await recordJobScope("job-1", "spec-kit", "p1", NOW);
    expect(jobScopeRecord.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: NOW } },
    });
  });

  it("logs, and does not throw, when the write fails — the in-process scope still holds", async () => {
    jobScopeRecord.upsert.mockRejectedValue(new Error("db down"));
    await expect(recordJobScope("job-2", "pr-review", null, NOW)).resolves.toBeUndefined();
    expect(getJobScope("job-2")).toEqual({ kind: "pr-review", projectId: null });
    expect(jobScopeRecord.deleteMany).not.toHaveBeenCalled();
  });

  it("swallows a failed prune", async () => {
    jobScopeRecord.deleteMany.mockRejectedValue(new Error("db down"));
    await expect(recordJobScope("job-3", "spec-kit", "p1", NOW)).resolves.toBeUndefined();
    // Let the rejected prune settle; an unhandled rejection would fail the run.
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("readJobScope", () => {
  it("reads only an unexpired record", async () => {
    jobScopeRecord.findFirst.mockResolvedValue({ kind: "overview-regenerate", projectId: "p1" });
    expect(await readJobScope("job-1", NOW)).toEqual({
      kind: "overview-regenerate",
      projectId: "p1",
    });
    expect(jobScopeRecord.findFirst).toHaveBeenCalledWith({
      where: { jobId: "job-1", expiresAt: { gt: NOW } },
      select: { kind: true, projectId: true },
    });
  });

  it("answers null for no record", async () => {
    expect(await readJobScope("missing", NOW)).toBeNull();
  });

  it("answers null for a record whose kind is not a job kind", async () => {
    jobScopeRecord.findFirst.mockResolvedValue({ kind: "not-a-kind", projectId: "p1" });
    expect(await readJobScope("job-1", NOW)).toBeNull();
  });

  it("propagates a read failure, so the subscribe is refused and logged", async () => {
    jobScopeRecord.findFirst.mockRejectedValue(new Error("db down"));
    await expect(readJobScope("job-1", NOW)).rejects.toThrow("db down");
  });
});
