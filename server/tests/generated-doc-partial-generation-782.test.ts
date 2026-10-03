/**
 * #782 — a full-scope BRD ran for 77 minutes, wrote its sections and failed in
 * its last second: nothing was saved, the only explanation was "the details are
 * in the server log", and a regenerate started over.
 *
 * Drives the REAL `generateDocumentAsync` and holistic synthesis against an
 * in-memory `generated_documents` row; only I/O (DB, LLM, retrieval, socket
 * events) is faked. Every assertion reads the row back, as the UI does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  doc: {} as Record<string, unknown>,
  versions: [] as Array<Record<string, unknown>>,
  symbols: [] as Array<Record<string, unknown>>,
  stream: vi.fn(),
  failIndexWarnings: false,
  failAfterSynthesis: false,
  failCommit: false,
  changeInputs: false,
}));

vi.mock("../src/lib/prisma.js", () => {
  const prisma = {
    project: {
      findFirst: vi.fn(async () => ({ id: "p", name: "Project", description: "System" })),
      findUnique: vi.fn(async () => ({ name: "Project" })),
    },
    user: {
      findFirst: vi.fn(async () => ({
        id: "u",
        username: "user",
        roles: [{ role: { key: "admin" } }],
        workspaceMemberships: [],
      })),
    },
    repoConnection: {
      findUnique: vi.fn(async ({ where }) => ({ id: where.id, projectId: "p" })),
      findFirst: vi.fn(async ({ where }) => (where.projectId === "p" ? { id: where.id } : null)),
    },
    codeGraph: {
      findFirst: vi.fn(async ({ where }) => ({ id: `g-${where.repoConnectionId}` })),
      findMany: vi.fn(async () => [
        {
          id: "g-r",
          commitSha: "sha",
          repoConnection: { id: "r", projectId: "p", deletedAt: null },
        },
      ]),
    },
    codeSymbol: {
      findMany: vi.fn(async (args: { select?: Record<string, unknown> }) => {
        // The first read after synthesis returned (the code-graph hash).
        if (state.failAfterSynthesis && args.select?.contentHash) {
          throw new TypeError("Cannot read properties of undefined (reading 'secret-path')");
        }
        if (state.changeInputs && args.select?.contentHash) {
          state.symbols = state.symbols.map((s) => ({ ...s, contentHash: `${s.contentHash}x` }));
        }
        return state.symbols;
      }),
      groupBy: vi.fn(async () => [
        { codeGraphId: "g-r", filePath: "src/api.ts", _count: { _all: state.symbols.length } },
      ]),
    },
    codeEdge: { findMany: vi.fn(async () => []) },
    knowledgeChunk: { findMany: vi.fn(async () => []) },
    finding: { findMany: vi.fn(async () => []) },
    docsGenFactCache: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    generatedDocument: {
      findFirst: vi.fn(async ({ where }) =>
        state.doc.deletedAt || where.id !== state.doc.id || where.projectId !== state.doc.projectId
          ? null
          : { ...state.doc },
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        // The publishing commit (it alone clears the checkpoint), not a salvage.
        if (state.failCommit && data.content && Object.hasOwn(data, "generationCheckpoint")) {
          throw new Error("commit failed: disk I/O error at /var/lib/metis/dev.db");
        }
        if (
          state.doc.deletedAt ||
          (Object.hasOwn(where, "codeGraphHash") &&
            state.doc.codeGraphHash !== where.codeGraphHash) ||
          (where.status && state.doc.status !== where.status) ||
          (where.updatedAt &&
            new Date(state.doc.updatedAt as Date).getTime() !== where.updatedAt.getTime()) ||
          (where.OR && state.doc.status === "generating")
        )
          return { count: 0 };
        Object.assign(state.doc, data, { updatedAt: new Date() });
        return { count: 1 };
      }),
    },
    generatedDocumentVersion: {
      findFirst: vi.fn(async () => state.versions.at(-1) ?? null),
      create: vi.fn(async ({ data }) => {
        state.versions.push(data);
        return data;
      }),
    },
    task: {
      upsert: vi.fn(async ({ create }) => ({ ...create, status: "pending" })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn) => fn(prisma)),
  };
  return { prisma, Prisma: { DbNull: null } };
});
vi.mock("../src/lib/ai/index.js", () => ({
  loadAIConfig: () => ({ provider: "test", model: "test-model" }),
  buildProvider: () => ({
    key: "test",
    model: "test-model",
    offline: false,
    stream: state.stream,
    complete: vi.fn(async () => ({ content: '{"claims":[]}' })),
    chat: vi.fn(async () => ({ content: '{"claims":[]}' })),
  }),
}));
vi.mock("../src/lib/ai/config.js", () => ({
  loadAIConfig: () => ({ provider: "test", model: "test-model" }),
}));
vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ search: vi.fn(async () => ({ hits: [] })) }),
}));
vi.mock("../src/lib/analysis/analysis-service.js", () => ({
  getLatestWebResearch: vi.fn(async () => ({ digests: [] })),
}));
vi.mock("../src/lib/docs-gen/generated-doc-publication.js", () => ({
  GENERATED_DOC_PUBLICATION_TASK_TYPE: "publish-generated-document",
  enqueueGeneratedDocPublication: vi.fn(),
  publishGeneratedDocRevision: vi.fn(),
  settleCancelledGeneratedDocPublication: vi.fn(),
  enqueueGeneratedDocDeletion: vi.fn(),
  generatedDocSyntheticDocumentId: (id: string) => `gendoc-${id}`,
}));
vi.mock("../src/lib/docs-gen/generated-doc-outbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/docs-gen/generated-doc-outbox.js")>()),
  dispatchGeneratedDocTask: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/connectors/source-ingest-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/connectors/source-ingest-state.js")>();
  return {
    ...actual,
    repositoryIndexWarnings: vi.fn(async () => {
      if (state.failIndexWarnings) throw new RangeError("Invalid array length");
      return [];
    }),
  };
});
vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../src/lib/socket/job-events.js", () => ({
  jobEvents: {
    started: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    progress: vi.fn(),
    docSection: vi.fn(),
  },
  genericFailureMessage: () => "failed",
}));

import { generateDocumentAsync } from "../src/routes/generated-docs.js";
import { jobEvents } from "../src/lib/socket/job-events.js";
import { checkpointSectionRecords } from "../src/lib/docs-gen/section-reuse.js";
import { sectionGroupsFor } from "../src/lib/docs-gen/holistic-synthesizer.js";
import { GENERATION_FAILED_MESSAGE } from "../src/lib/docs-gen/generation-failure-message.js";

const GROUPS = sectionGroupsFor("architecture");
const sectionCalls = () =>
  state.stream.mock.calls.filter(([messages]) =>
    /Section group: \*\*/.test(String((messages as Array<{ content: string }>).at(-1)?.content)),
  ).length;
const warnings = () => state.doc.warnings as Array<Record<string, unknown>>;
const cause = () => warnings().find((w) => typeof w.stage === "string");

beforeEach(() => {
  vi.clearAllMocks();
  state.versions.length = 0;
  state.failIndexWarnings = false;
  state.failAfterSynthesis = false;
  state.failCommit = false;
  state.changeInputs = false;
  state.doc = {
    id: "d",
    projectId: "p",
    title: "Architecture",
    scope: "repository",
    scopeFilter: JSON.stringify({ repoConnectorId: "r", docType: "architecture" }),
    evidencePolicy: JSON.stringify({
      version: 1,
      principal: { kind: "initiating-user", userId: "u" },
      sharedDocumentIds: [],
      allowWebResearch: false,
    }),
    autoUpdate: false,
    status: "pending",
    content: "",
    codeGraphHash: null,
    generationCheckpoint: null,
    deletedAt: null,
    updatedAt: new Date(),
  };
  state.symbols = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    projectId: "p",
    codeGraphId: "g-r",
    graph: { repoConnectionId: "r" },
    filePath: "src/api.ts",
    qualifiedName: `Api.fn${i}`,
    kind: i === 0 ? "class" : "method",
    contentHash: `${i}`,
    startLine: i + 1,
    endLine: i + 2,
    language: "ts",
    source: null,
  }));
  state.stream.mockImplementation(async function* (messages) {
    const user = messages.at(-1).content as string;
    const label = user.match(/Section group: \*\*(.+?)\*\*/)?.[1];
    yield {
      type: "delta",
      content: label
        ? `## ${label}\n\nThe API validates requests.\n`
        : "PURPOSE\nAn API module.\nRULES\n- Requests are validated.\n",
    };
    yield { type: "done" };
  });
  for (const key of ["BEDROCK_GATEWAY_URL", "BEDROCK_BASE_URL", "DOCS_GEN_PHASE2_ROUTING"])
    vi.stubEnv(key, "");
});

describe("#782 — every finished section is checkpointed on the document", () => {
  it("writes the checkpoint after each section, and clears it on publish", async () => {
    const { prisma } = await import("../src/lib/prisma.js");
    await generateDocumentAsync("d", "p");

    // Published (this fixture's sections carry ordinary grounding warnings).
    expect(state.versions).toHaveLength(1);
    expect(state.doc.generationCheckpoint).toBeNull();
    const writes = vi
      .mocked(prisma.generatedDocument.updateMany)
      .mock.calls.map(([args]) => args as { where: Record<string, unknown>; data: object })
      .filter((args) => Object.keys(args.data).join() === "generationCheckpoint");
    // One write per section, each holding every section finished so far.
    expect(writes).toHaveLength(GROUPS.length);
    writes.forEach((w, i) => {
      const saved = (w.data as { generationCheckpoint: { records: unknown[] } })
        .generationCheckpoint;
      expect(saved.records).toHaveLength(i + 1);
      // Only while this run holds its claim.
      expect(w.where.codeGraphHash).toMatch(/^regenerating:/);
    });
  });
});

describe("#782 — a late failure keeps what was finished", () => {
  it("keeps the assembled document as degraded when it fails after synthesis", async () => {
    state.failAfterSynthesis = true;
    await generateDocumentAsync("d", "p");

    expect(state.doc.status).toBe("degraded");
    for (const group of GROUPS) expect(state.doc.content).toContain(`## ${group.label}`);
    expect(state.doc.errorMessage).toBeNull();
    // The claim is released, never left pointing at a dead run.
    expect(state.doc.codeGraphHash).toBeNull();
    expect(cause()).toMatchObject({
      kind: "section-failed",
      section: "Document",
      stage: "assembly",
      errorClass: "TypeError",
      severity: "error",
      detailSafe: true,
    });
    // Never the exception's own text.
    expect(JSON.stringify(state.doc.warnings)).not.toContain("secret-path");
    expect(cause()!.message).toContain(GENERATION_FAILED_MESSAGE);
    // Not a version: nothing is published from a run that did not finish.
    expect(state.versions).toHaveLength(0);
    expect(jobEvents.completed).toHaveBeenCalledOnce();
    expect(jobEvents.failed).not.toHaveBeenCalled();
    // The checkpoint stays, so a regenerate can finish the job.
    expect(
      checkpointSectionRecords(
        state.doc.generationCheckpoint,
        GROUPS.map((g) => g.id),
        false,
      ).size,
    ).toBe(GROUPS.length);
  });

  it("assembles the checkpointed sections when the document itself was never assembled", async () => {
    state.failIndexWarnings = true;
    await generateDocumentAsync("d", "p");

    expect(state.doc.status).toBe("degraded");
    const content = String(state.doc.content);
    expect(content).toMatch(/^# Architecture\n/);
    expect(content).toContain("Incomplete document");
    for (const group of GROUPS) expect(content).toContain(`## ${group.label}`);
    expect(cause()).toMatchObject({ stage: "assembly", errorClass: "RangeError" });
    expect(String(cause()!.message)).not.toContain("Invalid array length");
  });

  it("never overwrites a published version with a partial one", async () => {
    state.versions.push({ version: 1, provenanceManifest: null });
    state.doc.status = "failed";
    state.doc.content = "# Published v1";
    state.failAfterSynthesis = true;
    await generateDocumentAsync("d", "p");

    expect(state.doc.status).toBe("failed");
    expect(state.doc.content).toBe("# Published v1");
    expect(state.doc.errorMessage).toBe(GENERATION_FAILED_MESSAGE);
    // The cause is still on the document, where the UI can show it.
    expect(warnings()).toEqual([expect.objectContaining({ stage: "assembly" })]);
    expect(state.doc.generationCheckpoint).not.toBeNull();
    expect(jobEvents.failed).toHaveBeenCalledOnce();
  });

  it("does not salvage a run whose commit failed; every section stays checkpointed", async () => {
    state.failCommit = true;
    await generateDocumentAsync("d", "p");

    expect(state.doc.status).toBe("failed");
    expect(state.doc.content).toBe("");
    expect(cause()).toMatchObject({ stage: "commit", errorClass: "Error" });
    expect(JSON.stringify(state.doc.warnings)).not.toContain("/var/lib");
    expect(
      checkpointSectionRecords(
        state.doc.generationCheckpoint,
        GROUPS.map((g) => g.id),
        false,
      ).size,
    ).toBe(GROUPS.length);
  });

  it("does not salvage a run whose inputs changed, and says why", async () => {
    state.changeInputs = true;
    await generateDocumentAsync("d", "p");

    expect(state.doc.status).toBe("failed");
    expect(state.doc.content).toBe("");
    expect(cause()).toMatchObject({ stage: "commit", errorClass: "UnpublishableGenerationError" });
    expect(String(cause()!.message)).toContain("sources changed");
  });
});

describe("#782 — regenerate resumes from the checkpoint", () => {
  it("reuses every checkpointed section instead of writing it again", async () => {
    state.failAfterSynthesis = true;
    await generateDocumentAsync("d", "p");
    expect(sectionCalls()).toBe(GROUPS.length);

    state.failAfterSynthesis = false;
    state.doc.status = "pending";
    state.stream.mockClear();
    await generateDocumentAsync("d", "p");

    expect(state.versions).toHaveLength(1);
    expect(sectionCalls()).toBe(0);
    for (const group of GROUPS) expect(state.doc.content).toContain(`## ${group.label}`);
    expect(state.doc.generationCheckpoint).toBeNull();
    expect(state.versions).toHaveLength(1);
  });

  it("writes again only the sections whose inputs changed", async () => {
    state.failAfterSynthesis = true;
    await generateDocumentAsync("d", "p");
    const saved = state.doc.generationCheckpoint as { records: Array<{ inputs: object }> };
    // Invalidate one record's inputs, as a changed source would.
    saved.records[0] = {
      ...saved.records[0],
      inputs: { ...saved.records[0].inputs, facts: "0".repeat(64) },
    };

    state.failAfterSynthesis = false;
    state.doc.status = "pending";
    state.stream.mockClear();
    await generateDocumentAsync("d", "p");

    expect(state.versions).toHaveLength(1);
    expect(sectionCalls()).toBe(1);
  });
});
