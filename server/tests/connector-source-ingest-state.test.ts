/**
 * Issue #182 — reading the recorded repository source-ingest state: when a run
 * counts as interrupted, when an index counts as partial, and the document
 * warning that follows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  update: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { repoConnection: { update: h.update, findMany: h.findMany } },
}));

import {
  SOURCE_INGEST_STALE_MS,
  describeIndexGap,
  effectiveSourceIngestStatus,
  parseSourceIngestState,
  repositoryIndexWarnings,
  settledStatus,
  sourceIngestSummary,
  writeSourceIngestState,
  type SourceIngestState,
} from "../src/lib/connectors/source-ingest-state.js";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");

function state(overrides: Partial<SourceIngestState> = {}): SourceIngestState {
  return {
    version: 1,
    runId: "run-1",
    status: "completed",
    startedAt: new Date(NOW - 60_000).toISOString(),
    heartbeatAt: new Date(NOW - 1_000).toISOString(),
    finishedAt: new Date(NOW).toISOString(),
    eligible: 10,
    selected: 10,
    processed: 10,
    created: 6,
    updated: 1,
    unchanged: 3,
    failed: 0,
    chunkCount: 40,
    skipped: { cap: 0, tooLarge: 0, unreadable: 0, excludedTests: 0 },
    limits: { maxFiles: 5000, maxFileBytes: 1048576, includeTests: true },
    ...overrides,
  };
}

beforeEach(() => {
  h.update.mockReset();
  h.findMany.mockReset();
});

describe("effective status", () => {
  it("a running state with a fresh heartbeat is running", () => {
    expect(effectiveSourceIngestStatus(state({ status: "running" }), NOW)).toBe("running");
  });

  it("a running state whose heartbeat went stale was interrupted", () => {
    const stale = new Date(NOW - SOURCE_INGEST_STALE_MS - 1).toISOString();
    expect(effectiveSourceIngestStatus(state({ status: "running", heartbeatAt: stale }), NOW)).toBe(
      "interrupted",
    );
    expect(
      effectiveSourceIngestStatus(state({ status: "running", heartbeatAt: "garbage" }), NOW),
    ).toBe("interrupted");
  });

  it("settled states are reported as recorded", () => {
    // A partial state carries the gap that made it partial (#217 re-derives from it).
    const gap = { cap: 1, tooLarge: 0, unreadable: 0, excludedTests: 0 };
    for (const status of ["completed", "partial", "failed"] as const) {
      expect(effectiveSourceIngestStatus(state({ status, skipped: gap }), NOW)).toBe(status);
    }
  });
});

describe("settledStatus", () => {
  it("is completed only when nothing eligible is missing", () => {
    expect(settledStatus(state())).toBe("completed");
    // A policy exclusion is a choice, not a gap.
    expect(
      settledStatus(state({ skipped: { cap: 0, tooLarge: 0, unreadable: 0, excludedTests: 4 } })),
    ).toBe("completed");
    expect(
      settledStatus(
        state({
          skipped: { cap: 0, tooLarge: 0, unreadable: 0, excludedTests: 0, excludedGenerated: 3 },
        }),
      ),
    ).toBe("completed");
  });

  it("#217: a file over REPO_SOURCE_MAX_FILE_BYTES is reported, not a gap", () => {
    expect(
      settledStatus(state({ skipped: { cap: 0, tooLarge: 2, unreadable: 0, excludedTests: 0 } })),
    ).toBe("completed");
  });

  it.each([
    ["cap", { cap: 1, tooLarge: 0, unreadable: 0, excludedTests: 0 }, 0],
    ["unreadable", { cap: 0, tooLarge: 0, unreadable: 1, excludedTests: 0 }, 0],
    ["failed", { cap: 0, tooLarge: 0, unreadable: 0, excludedTests: 0 }, 1],
  ])("is partial when %s > 0", (_name, skipped, failed) => {
    expect(settledStatus(state({ skipped, failed }))).toBe("partial");
  });
});

describe("parse / summary", () => {
  it("rejects missing, malformed and unknown-version values", () => {
    expect(parseSourceIngestState(null)).toBeNull();
    expect(parseSourceIngestState("{not json")).toBeNull();
    expect(parseSourceIngestState(JSON.stringify({ version: 2, status: "completed" }))).toBeNull();
    expect(parseSourceIngestState(JSON.stringify(state()))).toEqual(state());
  });

  it("summarises for the API with the effective status and the indexed count", () => {
    const stale = new Date(NOW - SOURCE_INGEST_STALE_MS - 1).toISOString();
    const summary = sourceIngestSummary(
      JSON.stringify(state({ status: "running", heartbeatAt: stale })),
      NOW,
    );
    expect(summary).toMatchObject({
      status: "running",
      effectiveStatus: "interrupted",
      indexed: 10,
    });
    expect(sourceIngestSummary(null)).toBeNull();
  });
});

describe("describeIndexGap", () => {
  it("is null for a completed index", () => {
    expect(describeIndexGap(state(), NOW)).toBeNull();
  });

  it("treats a never-recorded index as unknown coverage, not complete", () => {
    expect(describeIndexGap(null, NOW)).toContain("never recorded");
  });

  it("names the budget, unreadable files and embed failures — not oversize files (#217)", () => {
    const gap = describeIndexGap(
      state({
        status: "partial",
        failed: 1,
        skipped: { cap: 5, tooLarge: 2, unreadable: 1, excludedTests: 0 },
      }),
      NOW,
    );
    expect(gap).toBe(
      "10 of 10 eligible source file(s) are indexed (5 past the REPO_SOURCE_MAX_FILES limit, " +
        "1 unreadable, 1 failed to embed)",
    );
  });

  it("#217: a state recorded partial only for oversize files (pre-#217 policy) is no gap", () => {
    // #209 settled such a run as `partial`; the stored row outlives the policy
    // change, so the reader re-derives rather than trusting the stored status.
    const legacy = state({
      status: "partial",
      skipped: { cap: 0, tooLarge: 1, unreadable: 0, excludedTests: 0 },
    });
    expect(describeIndexGap(legacy, NOW)).toBeNull();
    // The connector view reads the same, so it never says "partial" while documents say complete.
    expect(sourceIngestSummary(JSON.stringify(legacy), NOW)).toMatchObject({
      status: "partial",
      effectiveStatus: "completed",
    });
    // A genuinely partial state stays partial.
    expect(
      effectiveSourceIngestStatus(
        state({
          status: "partial",
          skipped: { cap: 1, tooLarge: 1, unreadable: 0, excludedTests: 0 },
        }),
        NOW,
      ),
    ).toBe("partial");
  });

  it("describes running, interrupted and failed runs", () => {
    expect(describeIndexGap(state({ status: "running" }), NOW)).toContain("still running");
    const stale = new Date(NOW - SOURCE_INGEST_STALE_MS - 1).toISOString();
    expect(
      describeIndexGap(
        state({ status: "running", heartbeatAt: stale, processed: 174, selected: 860 }),
        NOW,
      ),
    ).toContain("interrupted after 174 of 860 file(s)");
    expect(describeIndexGap(state({ status: "failed" }), NOW)).toContain("failed");
  });
});

describe("writeSourceIngestState", () => {
  it("stores the state as JSON on the connector", async () => {
    h.update.mockResolvedValue({});
    await writeSourceIngestState("c1", state());
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { sourceIngestState: JSON.stringify(state()) },
    });
  });

  it("never fails the ingest when the write fails", async () => {
    h.update.mockRejectedValue(new Error("no such column"));
    await expect(writeSourceIngestState("c1", state())).resolves.toBeUndefined();
  });
});

describe("repositoryIndexWarnings", () => {
  it("warns for each partial or unrecorded repository and not for a complete one", async () => {
    h.findMany.mockResolvedValue([
      { id: "a", label: "complete", sourceIngestState: JSON.stringify(state()) },
      { id: "b", label: "legacy", sourceIngestState: null },
      {
        id: "c",
        label: "capped",
        sourceIngestState: JSON.stringify(
          state({
            status: "partial",
            skipped: { cap: 3, tooLarge: 0, unreadable: 0, excludedTests: 0 },
          }),
        ),
      },
    ]);

    const warnings = await repositoryIndexWarnings("p1", undefined, NOW);

    expect(warnings.map((w) => w.message.match(/repository "([^"]+)"/)?.[1])).toEqual([
      "legacy",
      "capped",
    ]);
    for (const w of warnings) {
      expect(w).toMatchObject({
        kind: "source-unavailable",
        section: "Document",
        severity: "warning",
      });
      expect(w.message).toContain("Re-sync the repository, then regenerate.");
    }
    expect(h.findMany).toHaveBeenCalledWith({
      where: { projectId: "p1", deletedAt: null },
      select: { id: true, label: true, sourceIngestState: true },
    });
  });

  it("narrows to the document's repository, scoped by project", async () => {
    h.findMany.mockResolvedValue([]);
    await repositoryIndexWarnings("p1", "repo-a", NOW);
    expect(h.findMany.mock.calls[0]?.[0].where).toEqual({
      projectId: "p1",
      deletedAt: null,
      id: "repo-a",
    });
  });

  it("returns no warning rather than failing generation when the read fails", async () => {
    h.findMany.mockRejectedValue(new Error("db down"));
    await expect(repositoryIndexWarnings("p1")).resolves.toEqual([]);
  });
});
