/**
 * Wired downstream-service handler overrides (review fix H4). Verifies that
 * each of the four advertised JobTypes resolves to the right service call,
 * passes the AbortSignal through, and returns a usable summary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const repoConnections = new Map<string, { id: string; projectId: string }>();
const dbConnections = new Map<string, { id: string; projectId: string }>();

const mocks = vi.hoisted(() => {
  return {
    fetchRepoMetadata: vi.fn(async () => ({
      repo: { full_name: "acme/api", default_branch: "main", size: 1 },
      languages: {},
      topLevel: [],
      readme: null,
      manifests: {},
      headSha: "abc",
    })),
    testRepoConnector: vi.fn(async () => ({ ok: true, latencyMs: 12 })),
    inspectDbConnector: vi.fn(async () => ({
      connectorId: "db1",
      driver: "postgres",
      schema: undefined,
      tables: [{ name: "t1" }, { name: "t2" }],
      extractedAt: new Date().toISOString(),
      durationMs: 7,
    })),
    runBatch: vi.fn(async () => ({ status: "completed" })),
    startAnalysis: vi.fn(async () => ({ id: "analysis_1" })),
    publishGeneratedDocRevision: vi.fn(async () => ({ status: "published", chunkCount: 2 })),
    settleCancelledGeneratedDocPublication: vi.fn(async () => {}),
    checkIncrementalRegeneration: vi.fn(async () => {}),
    runRegenerationTask: vi.fn(async () => {}),
    ingestRepoMetadata: vi.fn(async () => ({ failures: 0 })),
    ingestSourceAsKnowledge: vi.fn(async () => ({ chunkCount: 5, failures: 0 })),
    ingestCodeGraph: vi.fn(async () => ({ filesParsed: 2, symbolsUpserted: 10 })),
  };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    workspaceMember: { findMany: vi.fn(async () => []) },
    repoConnection: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => repoConnections.get(where.id) ?? null,
      ),
    },
    databaseConnection: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => dbConnections.get(where.id) ?? null,
      ),
    },
    project: {
      // Epic #164 — handler overrides now look up `autopilotEnabled` to
      // decide whether to wrap rerun-analysis with the autopilot rails.
      // The rerun-analysis test does not enable autopilot so we return a
      // disabled stub.
      findUnique: vi.fn(async () => ({ autopilotEnabled: false })),
    },
  },
}));

vi.mock("../src/lib/connectors/repo/repo-service.js", () => ({
  fetchRepoMetadata: mocks.fetchRepoMetadata,
  testRepoConnector: mocks.testRepoConnector,
  pullOrCloneRepo: vi.fn(async () => ({
    path: "/tmp/fake-clone",
    pulled: true,
    filesChanged: 3,
    headSha: "abc",
  })),
}));
vi.mock("../src/lib/connectors/db/db-service.js", () => ({
  inspectDbConnector: mocks.inspectDbConnector,
  // #316/#317 — refresh path builds SQL-lineage wiring; return empty (no DB
  // connector) so the scheduler test stays focused on the repo-refresh contract.
  buildCodeGraphSchemaWiring: vi.fn(async () => ({ introspectedSchema: null, routines: [] })),
}));
vi.mock("../src/lib/connectors/connector-ingest.js", () => ({
  ingestRepoMetadata: mocks.ingestRepoMetadata,
  ingestSourceAsKnowledge: mocks.ingestSourceAsKnowledge,
  ingestDbSchema: vi.fn(async () => ({ chunkCount: 4 })),
}));
vi.mock("../src/lib/code-graph/ingest.js", () => ({
  ingestCodeGraph: mocks.ingestCodeGraph,
}));
vi.mock("../src/lib/autopilot/index.js", () => ({
  runAutopilot: vi.fn(async () => ({})),
}));
vi.mock("../src/lib/publishing/publisher.js", () => ({ runBatch: mocks.runBatch }));
vi.mock("../src/lib/analysis/orchestrator.js", () => {
  class FakeOrchestrator {
    start = mocks.startAnalysis;
  }
  return {
    AnalysisOrchestrator: FakeOrchestrator,
    getOrchestrator: () => new FakeOrchestrator(),
  };
});
vi.mock("../src/lib/ai/index.js", () => ({
  buildProvider: () => ({}),
  loadAIConfig: () => ({}),
}));
vi.mock("../src/lib/docs-gen/generated-doc-publication.js", () => ({
  publishGeneratedDocRevision: mocks.publishGeneratedDocRevision,
  settleCancelledGeneratedDocPublication: mocks.settleCancelledGeneratedDocPublication,
}));
vi.mock("../src/lib/docs-gen/incremental.js", () => ({
  checkIncrementalRegeneration: mocks.checkIncrementalRegeneration,
  runRegenerationTask: mocks.runRegenerationTask,
}));

import { buildSchedulerHandlerOverrides } from "../src/lib/scheduler/handler-overrides.js";
import {
  INGEST_IN_PROGRESS,
  acquireConnectorIngest,
  isConnectorIngestActive,
} from "../src/lib/connectors/ingest-guard.js";

afterEach(() => {
  repoConnections.clear();
  dbConnections.clear();
  vi.clearAllMocks();
});

describe("scheduled repo refresh takes the per-connector ingest guard (#217)", () => {
  it("refuses while another entry point holds the connector, without pulling or ingesting", async () => {
    repoConnections.set("rc1", { id: "rc1", projectId: "p-alpha" });
    const lease = acquireConnectorIngest("rc1", "sync-route");
    try {
      await expect(
        buildSchedulerHandlerOverrides().refreshRepoConnector!("rc1", new AbortController().signal),
      ).rejects.toMatchObject({ status: 409, code: INGEST_IN_PROGRESS });
      expect(mocks.ingestCodeGraph).not.toHaveBeenCalled();
      expect(mocks.ingestSourceAsKnowledge).not.toHaveBeenCalled();
      expect(isConnectorIngestActive("rc1")).toBe(true);
    } finally {
      lease.release();
    }
  });

  it("holds the guard for the whole refresh, hands its lease to the source ingest, and releases it", async () => {
    repoConnections.set("rc1", { id: "rc1", projectId: "p-alpha" });
    let heldDuringSource = false;
    mocks.ingestSourceAsKnowledge.mockImplementationOnce(async (...args: unknown[]) => {
      heldDuringSource = isConnectorIngestActive("rc1");
      const opts = args[4] as { lease?: { connectorId: string; held: boolean } } | undefined;
      expect(opts?.lease).toMatchObject({ connectorId: "rc1", held: true });
      return { chunkCount: 5, failures: 0 };
    });
    await buildSchedulerHandlerOverrides().refreshRepoConnector!(
      "rc1",
      new AbortController().signal,
    );
    expect(heldDuringSource).toBe(true);
    expect(isConnectorIngestActive("rc1")).toBe(false);
  });

  it("releases the guard when the refresh fails", async () => {
    repoConnections.set("rc1", { id: "rc1", projectId: "p-alpha" });
    mocks.ingestCodeGraph.mockRejectedValueOnce(new Error("graph failed"));
    await expect(
      buildSchedulerHandlerOverrides().refreshRepoConnector!("rc1", new AbortController().signal),
    ).rejects.toThrow("graph failed");
    expect(isConnectorIngestActive("rc1")).toBe(false);
  });
});

describe("buildSchedulerHandlerOverrides", () => {
  it("delegates regeneration to the production runner with the original payload and signal (#1356)", async () => {
    const overrides = buildSchedulerHandlerOverrides();
    const payload = {
      projectId: "p1",
      generatedDocumentId: "d1",
      expectedVersion: 2,
      fingerprint: "hash",
    };
    const signal = new AbortController().signal;
    expect(overrides.regenerateGeneratedDocument).toBe(mocks.runRegenerationTask);
    await overrides.regenerateGeneratedDocument!(payload, signal);
    expect(mocks.runRegenerationTask).toHaveBeenCalledExactlyOnceWith(payload, signal);
  });

  it("schedules regeneration only after graph, source, metadata and connectivity finish (#1356)", async () => {
    repoConnections.set("rc1", { id: "rc1", projectId: "p-alpha" });
    await buildSchedulerHandlerOverrides().refreshRepoConnector!(
      "rc1",
      new AbortController().signal,
    );
    expect(mocks.checkIncrementalRegeneration).toHaveBeenCalledExactlyOnceWith("p-alpha", "rc1");
    const scheduledAt = mocks.checkIncrementalRegeneration.mock.invocationCallOrder[0];
    for (const ingest of [
      mocks.ingestCodeGraph,
      mocks.ingestSourceAsKnowledge,
      mocks.ingestRepoMetadata,
      mocks.testRepoConnector,
    ]) {
      expect(ingest.mock.invocationCallOrder[0]).toBeLessThan(scheduledAt);
    }
  });

  it.each(["graph", "source", "metadata", "metadata-fetch", "connectivity"] as const)(
    "does not schedule regeneration after a thrown %s failure (#1356)",
    async (stage) => {
      repoConnections.set("rc1", { id: "rc1", projectId: "p-alpha" });
      const dependency = {
        graph: mocks.ingestCodeGraph,
        source: mocks.ingestSourceAsKnowledge,
        metadata: mocks.ingestRepoMetadata,
        "metadata-fetch": mocks.fetchRepoMetadata,
        connectivity: mocks.testRepoConnector,
      }[stage];
      const error = new Error(`${stage} failed`);
      dependency.mockRejectedValueOnce(error);
      await expect(
        buildSchedulerHandlerOverrides().refreshRepoConnector!("rc1", new AbortController().signal),
      ).rejects.toBe(error);
      expect(mocks.checkIncrementalRegeneration).not.toHaveBeenCalled();
    },
  );

  it.each([
    [1, 0],
    [0, 1],
    [1, 1],
  ])(
    "does not schedule with source failures=%i, metadata failures=%i (#1356)",
    async (sourceFailures, metadataFailures) => {
      repoConnections.set("rc1", { id: "rc1", projectId: "p-alpha" });
      mocks.ingestSourceAsKnowledge.mockResolvedValueOnce({
        chunkCount: 5,
        failures: sourceFailures,
      });
      mocks.ingestRepoMetadata.mockResolvedValueOnce({ failures: metadataFailures });
      await expect(
        buildSchedulerHandlerOverrides().refreshRepoConnector!("rc1", new AbortController().signal),
      ).resolves.toMatchObject({ chunksIngested: 5 });
      expect(mocks.checkIncrementalRegeneration).not.toHaveBeenCalled();
    },
  );

  it("does not schedule after cancellation during ingest (#1356)", async () => {
    repoConnections.set("rc1", { id: "rc1", projectId: "p-alpha" });
    const controller = new AbortController();
    mocks.ingestRepoMetadata.mockImplementationOnce(async () => {
      controller.abort();
      return { failures: 0 };
    });
    await expect(
      buildSchedulerHandlerOverrides().refreshRepoConnector!("rc1", controller.signal),
    ).rejects.toThrow("aborted");
    expect(mocks.checkIncrementalRegeneration).not.toHaveBeenCalled();
  });

  it("propagates regeneration scheduling failures for retry (#1356)", async () => {
    repoConnections.set("rc1", { id: "rc1", projectId: "p-alpha" });
    const error = new Error("outbox unavailable");
    mocks.checkIncrementalRegeneration.mockRejectedValueOnce(error);
    await expect(
      buildSchedulerHandlerOverrides().refreshRepoConnector!("rc1", new AbortController().signal),
    ).rejects.toBe(error);
  });

  it("refresh-repo-connector resolves projectId and calls metadata + test", async () => {
    repoConnections.set("rc1", { id: "rc1", projectId: "p-alpha" });
    const overrides = buildSchedulerHandlerOverrides();
    const ac = new AbortController();
    const out = await overrides.refreshRepoConnector!("rc1", ac.signal);
    expect(out).toMatchObject({ repo: "acme/api", headSha: "abc", latencyMs: 12 });
    expect(mocks.fetchRepoMetadata).toHaveBeenCalledWith("p-alpha", "rc1", "system");
    expect(mocks.testRepoConnector).toHaveBeenCalledWith("p-alpha", "rc1", "system");
  });

  it("refresh-repo-connector throws on aborted signal", async () => {
    repoConnections.set("rc1", { id: "rc1", projectId: "p" });
    const overrides = buildSchedulerHandlerOverrides();
    const ac = new AbortController();
    ac.abort();
    await expect(overrides.refreshRepoConnector!("rc1", ac.signal)).rejects.toThrow(/aborted/);
  });

  it("refresh-db-connector-schema returns table count", async () => {
    dbConnections.set("db1", { id: "db1", projectId: "p-db" });
    const overrides = buildSchedulerHandlerOverrides();
    const out = await overrides.refreshDbConnectorSchema!("db1", new AbortController().signal);
    expect(out).toEqual({ tableCount: 2, durationMs: 7, chunksIngested: 4 });
    expect(mocks.inspectDbConnector).toHaveBeenCalledWith("p-db", "db1", "system");
  });

  it("rerun-analysis kicks off the orchestrator and surfaces the analysis id", async () => {
    const overrides = buildSchedulerHandlerOverrides();
    const out = await overrides.rerunAnalysis!("p-x", new AbortController().signal);
    expect(out).toEqual({ analysisId: "analysis_1" });
    expect(mocks.startAnalysis).toHaveBeenCalledWith({ projectId: "p-x", startedById: "system" });
  });

  it("publish-batch invokes runBatch with non-dry-run defaults", async () => {
    const overrides = buildSchedulerHandlerOverrides();
    const out = await overrides.publishBatch!("batch-99", new AbortController().signal);
    expect(out).toEqual({ batchId: "batch-99", status: "completed" });
    expect(mocks.runBatch).toHaveBeenCalledWith({
      batchId: "batch-99",
      dryRun: false,
      secretRef: null,
    });
  });

  it("publish-generated-document delegates to publishGeneratedDocRevision", async () => {
    const overrides = buildSchedulerHandlerOverrides();
    const out = await overrides.publishGeneratedDocument!(
      "doc-1",
      "proj-1",
      5,
      "rev-5",
      new AbortController().signal,
    );

    expect(mocks.publishGeneratedDocRevision).toHaveBeenCalledWith(
      {
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 5,
        revisionId: "rev-5",
      },
      { signal: expect.any(AbortSignal), onProgress: undefined, finalAttempt: undefined },
    );
    expect(out).toEqual({ status: "published", chunkCount: 2 });
  });

  it("#189 — publish-generated-document forwards progress and the final-attempt flag", async () => {
    const overrides = buildSchedulerHandlerOverrides();
    const onProgress = vi.fn();
    await overrides.publishGeneratedDocument!(
      "doc-1",
      "proj-1",
      5,
      "rev-5",
      new AbortController().signal,
      { onProgress, finalAttempt: true },
    );
    expect(mocks.publishGeneratedDocRevision).toHaveBeenLastCalledWith(expect.anything(), {
      signal: expect.any(AbortSignal),
      onProgress,
      finalAttempt: true,
    });
  });

  it("#201 — wires the settle hook for a publication cancelled before it ran", async () => {
    const overrides = buildSchedulerHandlerOverrides();
    const payload = {
      generatedDocumentId: "doc-1",
      projectId: "proj-1",
      version: 5,
      revisionId: "rev-5",
    };
    await overrides.settleCancelledGeneratedDocPublication!(payload, "cancelled by alice");
    expect(mocks.settleCancelledGeneratedDocPublication).toHaveBeenCalledWith(
      payload,
      "cancelled by alice",
    );
  });

  it("rerun-analysis uses autopilot rails when the project enables them", async () => {
    const { prisma } = await import("../src/lib/prisma.js");
    const { runAutopilot } = await import("../src/lib/autopilot/index.js");
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({ autopilotEnabled: true });
    vi.mocked(runAutopilot).mockResolvedValueOnce({
      status: "completed",
      result: { id: "analysis_auto" },
    });

    const overrides = buildSchedulerHandlerOverrides();
    const out = await overrides.rerunAnalysis!("p-x", new AbortController().signal);

    expect(runAutopilot).toHaveBeenCalled();
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
    expect(out).toEqual({ analysisId: "analysis_auto" });
  });

  it("rerun-analysis surfaces autopilot aborts as errors", async () => {
    const { prisma } = await import("../src/lib/prisma.js");
    const { runAutopilot } = await import("../src/lib/autopilot/index.js");
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({ autopilotEnabled: true });
    vi.mocked(runAutopilot).mockResolvedValueOnce({
      status: "aborted",
      reason: "budget-exceeded",
    });

    const overrides = buildSchedulerHandlerOverrides();
    await expect(overrides.rerunAnalysis!("p-x", new AbortController().signal)).rejects.toThrow(
      /autopilot budget-exceeded/,
    );
  });

  it("custom overrides take precedence over the wired implementations", async () => {
    const refreshRepoConnector = vi.fn(async () => ({ injected: true }));
    const overrides = buildSchedulerHandlerOverrides({ refreshRepoConnector });
    await overrides.refreshRepoConnector!("rc-test", new AbortController().signal);
    expect(refreshRepoConnector).toHaveBeenCalled();
  });

  it("repo handler throws when the connector row is missing", async () => {
    const overrides = buildSchedulerHandlerOverrides();
    await expect(
      overrides.refreshRepoConnector!("missing", new AbortController().signal),
    ).rejects.toThrow(/not found/);
  });
});
