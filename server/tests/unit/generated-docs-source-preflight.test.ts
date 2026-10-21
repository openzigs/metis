/**
 * #1322 — a document generated from a repository whose clone was purged stops
 * before ANY model call, with a fixed "re-ingest" message on the document.
 *
 * Real route → real captureGenerationInputs → real source preflight; only the
 * clone check's outcome (clone-health, covered on a real filesystem in
 * clone-health.test.ts) and the model-facing modules are stubbed, the latter so
 * the test can assert none of them was reached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  doc: null as Record<string, unknown> | null,
  graphs: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/lib/prisma.js", () => ({
  Prisma: { DbNull: Symbol("DbNull") },
  prisma: {
    generatedDocument: {
      findFirst: vi.fn(async () => db.doc),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(),
    },
    generatedDocumentVersion: { findFirst: vi.fn(async () => null) },
    codeGraph: { findMany: vi.fn(async () => db.graphs) },
    codeSymbol: { findMany: vi.fn(async () => []) },
    codeEdge: { findMany: vi.fn(async () => []) },
    knowledgeChunk: { findMany: vi.fn(async () => []) },
    analysis: { findMany: vi.fn(async () => []) },
    project: { findFirst: vi.fn(async () => ({ name: "P", description: null })) },
  },
}));

vi.mock("../../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/lib/docs-gen/evidence-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/docs-gen/evidence-policy.js")>()),
  resolveEvidencePolicy: vi.fn(async () => ({
    projectId: "proj-1",
    generatedDocumentId: "doc-1",
    actor: { userId: "user-1", role: "admin" },
    aclSubjects: [],
    sharedDocumentIds: [],
    allowWebResearch: true,
  })),
  assertEvidencePolicy: vi.fn(),
}));

vi.mock("../../src/lib/docs-gen/incremental.js", () => ({
  checkIncrementalRegeneration: vi.fn(async () => undefined),
}));

const ensureClone = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/connectors/repo/clone-health.js", () => ({
  ensureConnectorClone: ensureClone,
}));

// Everything that spends: none of it may be reached. (Constructing a provider
// makes no call — the input snapshot reads its model names — so the real
// constructors run; what would call a model is below.)
const spend = vi.hoisted(() => ({
  synthesize: vi.fn(),
  webResearch: vi.fn(),
  grounding: vi.fn(),
}));
vi.mock("../../src/lib/docs-gen/holistic-synthesizer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/docs-gen/holistic-synthesizer.js")>()),
  synthesizeHolisticDocument: spend.synthesize,
}));
vi.mock("../../src/lib/docs-gen/grounding/domain-web-research.js", () => ({
  runDomainWebResearch: spend.webResearch,
}));
vi.mock("../../src/lib/docs-gen/grounding/grounding-retrieval.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/lib/docs-gen/grounding/grounding-retrieval.js")
  >()),
  buildProjectGroundingContext: spend.grounding,
  buildSectionGroundingRetriever: spend.grounding,
}));

import { prisma } from "../../src/lib/prisma.js";
import { generateDocumentAsync } from "../../src/routes/generated-docs.js";
import {
  GENERATION_SOURCE_BUSY_MESSAGE,
  GENERATION_SOURCE_UNAVAILABLE_MESSAGE,
  generationFailureMessage,
} from "../../src/lib/docs-gen/generation-failure-message.js";
import { captureGenerationInputs } from "../../src/lib/docs-gen/generation-inputs.js";
import type { EvidencePolicy } from "../../src/lib/docs-gen/evidence-policy.js";

const SHA = "b".repeat(40);

function pendingDoc(scope: string) {
  return {
    id: "doc-1",
    projectId: "proj-1",
    title: "Business Requirements",
    scope,
    scopeFilter: JSON.stringify({ docType: "business-requirements" }),
    evidencePolicy: "{}",
    status: "pending",
    codeGraphHash: null,
    autoUpdate: false,
    errorMessage: null,
    warnings: null,
    updatedAt: new Date(0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.doc = pendingDoc("full");
  db.graphs = [
    {
      id: "graph-1",
      commitSha: SHA,
      repoConnection: { id: "conn-1", projectId: "proj-1", deletedAt: null, provider: "github" },
    },
  ];
});

describe("#1322 — generation from a purged clone", () => {
  it("stops before any model call and tells the user to re-ingest", async () => {
    ensureClone.mockResolvedValue({
      status: "unavailable",
      reason: "restore-failed",
      state: "hollow",
    });

    await generateDocumentAsync("doc-1", "proj-1");

    expect(ensureClone).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", connectorId: "conn-1" }),
    );
    expect(await ensureClone.mock.calls[0]![0].loadCommitSha()).toBe(SHA);
    for (const fn of Object.values(spend)) expect(fn).not.toHaveBeenCalled();
    // Never claimed: the pending row is failed with the fixed re-ingest message.
    expect(prisma.generatedDocument.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.generatedDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "failed", errorMessage: GENERATION_SOURCE_UNAVAILABLE_MESSAGE },
      }),
    );
    expect(GENERATION_SOURCE_UNAVAILABLE_MESSAGE).toMatch(/Re-ingest the repository/);
  });

  it("stops too when the clone is missing and no commit was recorded to restore", async () => {
    db.graphs[0]!.commitSha = null;
    ensureClone.mockResolvedValue({
      status: "unavailable",
      reason: "no-recorded-commit",
      state: "missing",
    });
    await generateDocumentAsync("doc-1", "proj-1");
    expect(await ensureClone.mock.calls[0]![0].loadCommitSha()).toBeNull();
    expect(spend.synthesize).not.toHaveBeenCalled();
  });

  it("another job holding the repository past the wait: try again later, never re-ingest", async () => {
    ensureClone.mockResolvedValue({ status: "unavailable", reason: "busy", state: "missing" });
    await generateDocumentAsync("doc-1", "proj-1");
    for (const fn of Object.values(spend)) expect(fn).not.toHaveBeenCalled();
    expect(prisma.generatedDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "failed", errorMessage: GENERATION_SOURCE_BUSY_MESSAGE },
      }),
    );
    expect(GENERATION_SOURCE_BUSY_MESSAGE).toMatch(/try again in a few minutes/i);
    expect(GENERATION_SOURCE_BUSY_MESSAGE).not.toMatch(/re-ingest/i);
  });

  it("a restored clone lets the run go on to snapshot the restored source", async () => {
    ensureClone.mockResolvedValue({ status: "restored", path: "/clones/conn-1" });
    await generateDocumentAsync("doc-1", "proj-1").catch(() => undefined);
    expect(ensureClone).toHaveBeenCalledOnce();
    // Past the preflight: the input snapshot read the graph.
    expect(prisma.codeSymbol.findMany).toHaveBeenCalled();
    expect(prisma.generatedDocument.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorMessage: GENERATION_SOURCE_UNAVAILABLE_MESSAGE }),
      }),
    );
  });

  it("does not check clones for a database-scoped document", async () => {
    db.doc = pendingDoc("database");
    await generateDocumentAsync("doc-1", "proj-1").catch(() => undefined);
    expect(ensureClone).not.toHaveBeenCalled();
  });
});

describe("#1322 L4 — an automatic regeneration checks clones only once it will run", () => {
  const signal = new AbortController().signal;
  async function currentFingerprint(): Promise<string> {
    const { resolveEvidencePolicy } = await import("../../src/lib/docs-gen/evidence-policy.js");
    const policy = (await resolveEvidencePolicy(db.doc as never)) as EvidencePolicy;
    return (await captureGenerationInputs(db.doc as never, policy)).fingerprint;
  }

  beforeEach(() => {
    db.doc = { ...pendingDoc("full"), status: "ready", autoUpdate: true };
    ensureClone.mockResolvedValue({
      status: "unavailable",
      reason: "restore-failed",
      state: "hollow",
    });
  });

  it("a task whose inputs moved on returns before touching any clone", async () => {
    const task = {
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      expectedVersion: 0,
      fingerprint: "stale-fingerprint",
    };
    await generateDocumentAsync("doc-1", "proj-1", { ...task, signal }).catch(() => undefined);
    expect(ensureClone).not.toHaveBeenCalled();
  });

  it("a task that will run checks the clones first, and stops before any model call", async () => {
    const task = {
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      expectedVersion: 0,
      fingerprint: await currentFingerprint(),
    };
    vi.clearAllMocks();
    await expect(
      generateDocumentAsync("doc-1", "proj-1", { ...task, signal }),
    ).rejects.toMatchObject({ code: "SOURCE_CLONE_UNAVAILABLE" });
    expect(ensureClone).toHaveBeenCalledOnce();
    for (const fn of Object.values(spend)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("generationFailureMessage", () => {
  it("maps the preflight's code to its fixed message and never echoes the error text", () => {
    const err = Object.assign(new Error("/secret/path conn-1"), {
      code: "SOURCE_CLONE_UNAVAILABLE",
    });
    expect(generationFailureMessage(err)).toBe(GENERATION_SOURCE_UNAVAILABLE_MESSAGE);
    expect(generationFailureMessage(GENERATION_SOURCE_UNAVAILABLE_MESSAGE)).toBe(
      GENERATION_SOURCE_UNAVAILABLE_MESSAGE,
    );
  });
});
