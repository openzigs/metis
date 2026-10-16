/**
 * #1171 — a batch created as a DRY RUN is never published live through the
 * scheduler's `publish-batch` handler, which always calls `runBatch` with
 * `dryRun: false`. The REAL `runBatch` runs here (only its collaborators are
 * stubbed), so this fails if the batch row stops being authoritative.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, Record<string, unknown>>();

const mocks = vi.hoisted(() => ({
  draftFindMany: vi.fn(async () => []),
  batchUpdate: vi.fn(async () => ({})),
  octokitFactory: vi.fn(),
}));

vi.mock("../../../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));
vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    publishBatch: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      update: mocks.batchUpdate,
    },
    issueDraft: { findMany: mocks.draftFindMany },
  },
}));
vi.mock("../../../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// Heavy collaborators of the other scheduler handlers — not under test here.
vi.mock("../../../src/lib/connectors/repo/repo-service.js", () => ({
  fetchRepoMetadata: vi.fn(),
  testRepoConnector: vi.fn(),
  pullOrCloneRepo: vi.fn(),
}));
vi.mock("../../../src/lib/connectors/db/db-service.js", () => ({
  inspectDbConnector: vi.fn(),
  buildCodeGraphSchemaWiring: vi.fn(),
}));
vi.mock("../../../src/lib/connectors/connector-ingest.js", () => ({
  ingestRepoMetadata: vi.fn(),
  ingestSourceAsKnowledge: vi.fn(),
  ingestDbSchema: vi.fn(),
}));
vi.mock("../../../src/lib/code-graph/ingest.js", () => ({ ingestCodeGraph: vi.fn() }));
vi.mock("../../../src/lib/autopilot/index.js", () => ({ runAutopilot: vi.fn() }));
vi.mock("../../../src/lib/analysis/orchestrator.js", () => ({
  AnalysisOrchestrator: vi.fn(),
  getOrchestrator: vi.fn(),
}));
vi.mock("../../../src/lib/ai/index.js", () => ({ buildProvider: vi.fn(), loadAIConfig: vi.fn() }));
vi.mock("../../../src/lib/docs-gen/generated-doc-publication.js", () => ({
  publishGeneratedDocRevision: vi.fn(),
  settleCancelledGeneratedDocPublication: vi.fn(),
}));
vi.mock("../../../src/lib/docs-gen/incremental.js", () => ({
  checkIncrementalRegeneration: vi.fn(),
  runRegenerationTask: vi.fn(),
}));

import { buildSchedulerHandlerOverrides } from "../../../src/lib/scheduler/handler-overrides.js";
import { runBatch } from "../../../src/lib/publishing/publisher.js";

function seed(id: string, dryRun: boolean): void {
  rows.set(id, {
    id,
    projectId: "proj_1",
    status: dryRun ? "completed" : "pending",
    targetOwner: "acme",
    targetRepo: "shared-repo",
    targetBaseUrl: null,
    provider: "github",
    dryRun,
    archived: false,
    metadata: JSON.stringify({ draftIds: ["d1"], secretRef: "${vault:gh}" }),
    startedById: "u1",
  });
}

beforeEach(() => {
  rows.clear();
  vi.clearAllMocks();
});

describe("a dry-run batch is never run live (#1171)", () => {
  it("the scheduler's publish-batch handler is refused for a dry-run batch", async () => {
    seed("batch_dry", true);
    const overrides = buildSchedulerHandlerOverrides();
    await expect(
      overrides.publishBatch!("batch_dry", new AbortController().signal),
    ).rejects.toMatchObject({ code: "BATCH_IS_DRY_RUN", status: 409 });
    // Refused before anything else is read or written.
    expect(mocks.draftFindMany).not.toHaveBeenCalled();
    expect(mocks.batchUpdate).not.toHaveBeenCalled();
  });

  it("runBatch refuses dryRun:false on a dry-run row even with a credential", async () => {
    seed("batch_dry", true);
    await expect(
      runBatch({ batchId: "batch_dry", dryRun: false, secretRef: "${vault:gh}" }),
    ).rejects.toMatchObject({ code: "BATCH_IS_DRY_RUN" });
  });

  it("a live batch still reaches the publisher (refused later for no credential, not as a dry run)", async () => {
    seed("batch_live", false);
    const overrides = buildSchedulerHandlerOverrides();
    const err = await overrides.publishBatch!("batch_live", new AbortController().signal).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(err?.code).not.toBe("BATCH_IS_DRY_RUN");
    expect(mocks.draftFindMany).toHaveBeenCalled();
  });
});
