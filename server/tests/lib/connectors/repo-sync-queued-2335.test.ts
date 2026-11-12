/**
 * #2335 panel — a Sync asked for while another run holds the connector is
 * queued, and its follow-up does what Sync does: the real ingest guard, the real
 * re-run runner (`refresh-trigger.ts`) and the real shared Sync body
 * (`repo-sync.ts`), over mocked I/O. The follow-up runs database-connection
 * discovery and its notification, and survives a `fetchRepoMetadata` failure
 * the way the Sync route does, where the unattended refresh would fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  discoveryEmit: vi.fn(),
  discover: vi.fn(),
  fetchRepoMetadata: vi.fn(),
  ingestRepoMetadata: vi.fn(),
  pullOrCloneRepo: vi.fn(),
  resolveNonGitIngestRoot: vi.fn(),
  getRepoConnector: vi.fn(),
  schedule: vi.fn(),
  findUnique: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../../../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: h.info, warn: h.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: { repoConnection: { findUnique: h.findUnique } },
}));
vi.mock("../../../src/lib/connectors/repo/repo-service.js", () => ({
  fetchRepoMetadata: h.fetchRepoMetadata,
  getRepoConnector: h.getRepoConnector,
  getRepoConnectorEmitter: () => ({ discovery: h.discoveryEmit }),
  pullOrCloneRepo: h.pullOrCloneRepo,
  resolveNonGitIngestRoot: h.resolveNonGitIngestRoot,
}));
vi.mock("../../../src/lib/code-graph/ingest.js", () => ({
  ingestCodeGraph: vi.fn(async () => ({
    filesScanned: 1,
    filesParsed: 1,
    filesSkipped: 0,
    symbolsUpserted: 0,
    edgesUpserted: 0,
    durationMs: 1,
  })),
}));
vi.mock("../../../src/lib/connectors/db/db-service.js", () => ({
  buildCodeGraphSchemaWiring: vi.fn(async () => ({})),
}));
vi.mock("../../../src/lib/connectors/connector-ingest.js", () => ({
  ingestSourceAsKnowledge: vi.fn(async () => ({
    documentsCreated: 1,
    documentsUpdated: 0,
    chunkCount: 1,
    failures: 0,
  })),
  ingestRepoMetadata: h.ingestRepoMetadata,
}));
vi.mock("../../../src/lib/connectors/repo/connection-discovery.js", () => ({
  discoverAndUpsertConnections: h.discover,
}));
vi.mock("../../../src/lib/docs-gen/regeneration-scheduling.js", () => ({
  scheduleIncrementalRegeneration: h.schedule,
}));
// The unattended refresh must not be what a queued Sync runs.
vi.mock("../../../src/lib/connectors/repo/repo-refresh.js", () => ({
  runRepoConnectorRefresh: h.refresh,
}));

import {
  acquireConnectorIngest,
  isConnectorIngestActive,
  setIngestRerunRunner,
} from "../../../src/lib/connectors/ingest-guard.js";
import {
  __resetRepoRefreshShutdown,
  installRepoRefreshRerunRunner,
  requestRepoConnectorRefresh,
} from "../../../src/lib/connectors/repo/refresh-trigger.js";
import { runQueuedRepoConnectorSync } from "../../../src/lib/connectors/repo/repo-sync.js";
import { tryAcquireConnectorIngest } from "../../../src/lib/connectors/ingest-guard.js";

beforeEach(() => {
  h.findUnique.mockResolvedValue({ projectId: "p1" });
  h.getRepoConnector.mockResolvedValue({ id: "rc1", provider: "github", label: "acme/app" });
  h.pullOrCloneRepo.mockResolvedValue({
    path: "/tmp/clone",
    sizeBytes: 10,
    pulled: true,
    filesChanged: 3,
    commitSha: "a".repeat(40),
  });
  h.fetchRepoMetadata.mockResolvedValue({ repo: { full_name: "acme/app" }, headSha: "a" });
  h.ingestRepoMetadata.mockResolvedValue({ failures: 0 });
  h.discover.mockResolvedValue({ filesScanned: 4, connectionsFound: 2, suggestionsUpserted: 2 });
  h.schedule.mockResolvedValue({ regenerationScheduled: true });
  installRepoRefreshRerunRunner();
});

afterEach(() => {
  setIngestRerunRunner(null);
  __resetRepoRefreshShutdown();
  vi.clearAllMocks();
});

/** Queue a manual Sync behind a running one, end the running one, and wait for the follow-up. */
async function queuedManualSync(connectorId = "rc1"): Promise<void> {
  const running = acquireConnectorIngest(connectorId, "refresh-ingest");
  expect(requestRepoConnectorRefresh(connectorId, { trigger: "manual" }).status).toBe("queued");
  running.release();
  expect(isConnectorIngestActive(connectorId)).toBe(true);
  await vi.waitFor(() => expect(isConnectorIngestActive(connectorId)).toBe(false));
}

describe("a queued manual Sync does what Sync does (#2335 panel)", () => {
  it("runs database-connection discovery and its notification", async () => {
    await queuedManualSync();
    expect(h.discover).toHaveBeenCalledExactlyOnceWith("p1", "/tmp/clone");
    expect(h.discoveryEmit).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      connectorId: "rc1",
      repoLabel: "acme/app",
      connectionsFound: 2,
    });
    expect(h.schedule).toHaveBeenCalledExactlyOnceWith("p1", "rc1");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(
      "connector.refresh.done",
      expect.objectContaining({ connectorId: "rc1", trigger: "manual" }),
    );
  });

  it("survives a metadata failure: discovery still runs and the run completes", async () => {
    h.fetchRepoMetadata.mockRejectedValueOnce(new Error("Metadata unavailable"));
    await queuedManualSync();
    expect(h.discover).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("fetchRepoMetadata failed"),
      expect.objectContaining({ connectorId: "rc1" }),
    );
    expect(h.warn).not.toHaveBeenCalledWith("connector.refresh.failed", expect.anything());
    // A partly failed Sync skips regeneration and says so, as the route does.
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it("runs as the system actor, and refuses a connector deleted while it waited", async () => {
    await queuedManualSync();
    expect(h.pullOrCloneRepo).toHaveBeenCalledWith("p1", "rc1", "system");
    h.getRepoConnector.mockRejectedValueOnce(new Error("repo connector not found"));
    await queuedManualSync();
    expect(h.warn).toHaveBeenCalledWith(
      "connector.refresh.failed",
      expect.objectContaining({ connectorId: "rc1", error: "repo connector not found" }),
    );
    expect(h.pullOrCloneRepo).toHaveBeenCalledTimes(1);
  });

  it("re-resolves a local or upload connector's root instead of pulling", async () => {
    h.getRepoConnector.mockResolvedValue({ id: "rc1", provider: "local", label: "local" });
    h.resolveNonGitIngestRoot.mockResolvedValue({ path: "/srv/code", boundary: "/srv" });
    await queuedManualSync();
    expect(h.pullOrCloneRepo).not.toHaveBeenCalled();
    expect(h.fetchRepoMetadata).not.toHaveBeenCalled();
    expect(h.discover).toHaveBeenCalledWith("p1", "/srv/code");
  });

  it("stops at once, releasing its lease, once the server is shutting down", async () => {
    const lease = tryAcquireConnectorIngest("rc-stop", "rerun:manual")!;
    await expect(runQueuedRepoConnectorSync("rc-stop", lease, AbortSignal.abort())).rejects.toThrow(
      "aborted",
    );
    expect(lease.held).toBe(false);
    expect(h.findUnique).not.toHaveBeenCalled();
  });
});
