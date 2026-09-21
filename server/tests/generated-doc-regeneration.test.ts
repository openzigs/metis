/** #1356: real scheduled ingest caller → real queue/store/registry → real
 * generation + holistic synthesis. Only I/O (DB, source ingest, LLM) is fake. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@prisma/client";

const state = vi.hoisted(() => ({
  doc: {} as Record<string, unknown>,
  versions: [] as Array<Record<string, unknown>>,
  tasks: new Map<string, Task>(),
  symbols: [] as Array<Record<string, unknown>>,
  edges: [] as Array<Record<string, unknown>>,
  chunks: [] as Array<Record<string, unknown>>,
  activeUser: true,
  failCommit: false,
  failTask: false,
  mutation: null as null | (() => void),
  stream: vi.fn(),
  search: vi.fn(),
  publications: vi.fn(),
  sourceIngest: vi.fn(),
  graphIngest: vi.fn(),
  metadataIngest: vi.fn(),
  webResearch: vi.fn(),
}));

type TaskFilter = {
  id?: string;
  type?: string;
  status?: string | { in: string[] };
  updatedAt?: { lt: Date };
};
function matchesTask(row: Task, where: TaskFilter): boolean {
  return (
    (!where.id || row.id === where.id) &&
    (!where.type || row.type === where.type) &&
    (!where.status ||
      (typeof where.status === "string"
        ? row.status === where.status
        : where.status.in.includes(row.status))) &&
    (!where.updatedAt || row.updatedAt < where.updatedAt.lt)
  );
}

vi.mock("../src/lib/prisma.js", () => {
  const prisma = {
    project: {
      findFirst: vi.fn(async () => ({ id: "p", name: "Project", description: "System" })),
      findUnique: vi.fn(async () => ({ name: "Project" })),
    },
    user: {
      findFirst: vi.fn(async () =>
        state.activeUser
          ? {
              id: "u",
              username: "user",
              roles: [{ role: { key: "admin" } }],
              workspaceMemberships: [],
            }
          : null,
      ),
    },
    repoConnection: { findUnique: vi.fn(async ({ where }) => ({ id: where.id, projectId: "p" })) },
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
      findMany: vi.fn(async ({ where }) =>
        state.symbols.filter((s) => !where.codeGraphId || s.codeGraphId === where.codeGraphId),
      ),
      groupBy: vi.fn(async () => [
        { codeGraphId: "g-r", filePath: "src/api.ts", _count: { _all: state.symbols.length } },
      ]),
    },
    codeEdge: { findMany: vi.fn(async () => state.edges) },
    knowledgeChunk: { findMany: vi.fn(async () => state.chunks) },
    finding: { findMany: vi.fn(async () => []) },
    docsGenFactCache: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    generatedDocument: {
      findFirst: vi.fn(async ({ where }) =>
        state.doc.deletedAt || where.id !== state.doc.id || where.projectId !== state.doc.projectId
          ? null
          : { ...state.doc },
      ),
      findMany: vi.fn(async () =>
        state.doc.deletedAt || !state.doc.autoUpdate ? [] : [{ ...state.doc }],
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        if (state.failCommit && data.content) {
          state.failCommit = false;
          throw new Error("transient commit");
        }
        if (
          state.doc.deletedAt ||
          (Object.hasOwn(where, "codeGraphHash") &&
            state.doc.codeGraphHash !== where.codeGraphHash) ||
          (where.status && state.doc.status !== where.status) ||
          (where.updatedAt &&
            new Date(state.doc.updatedAt as Date).getTime() !== where.updatedAt.getTime()) ||
          (where.autoUpdate && !state.doc.autoUpdate) ||
          (where.OR && state.doc.status === "generating") ||
          (where.versions &&
            state.versions.some(
              (v) =>
                Number(v.version) >
                Number(
                  where.versions.none.version.gt ?? Number(where.versions.none.version.gte) - 1,
                ),
            ))
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
      upsert: vi.fn(async ({ where, create }) => {
        if (state.failTask) {
          state.failTask = false;
          throw new Error("outbox unavailable");
        }
        if (!state.tasks.has(where.id))
          state.tasks.set(where.id, {
            scheduledJobId: null,
            projectId: null,
            trigger: "manual",
            status: "pending",
            attempts: 0,
            priority: 5,
            payload: "{}",
            result: null,
            errorMessage: null,
            progress: null,
            maxAttempts: 3,
            scheduledFor: null,
            startedAt: null,
            completedAt: null,
            createdById: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          });
        return { ...state.tasks.get(where.id)! };
      }),
      findUnique: vi.fn(async ({ where }) => {
        const row = state.tasks.get(where.id);
        return row ? { ...row } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const row = state.tasks.get(where.id);
        if (!row) throw new Error("Task not found");
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.tasks.get(where.id)!;
        Object.assign(row, data);
        return { ...row };
      }),
      findMany: vi.fn(async ({ where }: { where: TaskFilter }) =>
        [...state.tasks.values()]
          .filter((row) => matchesTask(row, where))
          .map((row) => ({ ...row })),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: TaskFilter;
          data: Omit<Partial<Task>, "attempts"> & { attempts?: number | { increment: number } };
        }) => {
          const rows = [...state.tasks.values()].filter((row) => matchesTask(row, where));
          for (const row of rows) {
            const attempts =
              typeof data.attempts === "object"
                ? row.attempts + data.attempts.increment
                : data.attempts;
            Object.assign(row, data, {
              ...(attempts === undefined ? {} : { attempts }),
              updatedAt: new Date(),
            });
          }
          return { count: rows.length };
        },
      ),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    scheduledJob: { findMany: vi.fn(async () => []) },
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
  }),
}));
vi.mock("../src/lib/ai/config.js", () => ({
  loadAIConfig: () => ({ provider: "test", model: "test-model" }),
}));
vi.mock("../src/lib/connectors/repo/repo-service.js", () => ({
  pullOrCloneRepo: vi.fn(async () => ({ path: "/missing-fixture", pulled: true, filesChanged: 1 })),
  fetchRepoMetadata: vi.fn(async () => ({ repo: { full_name: "org/repo" }, headSha: "sha" })),
  testRepoConnector: vi.fn(async () => ({ latencyMs: 1 })),
}));
vi.mock("../src/lib/connectors/db/db-service.js", () => ({
  buildCodeGraphSchemaWiring: vi.fn(async () => ({})),
  inspectDbConnector: vi.fn(),
}));
vi.mock("../src/lib/code-graph/ingest.js", () => ({ ingestCodeGraph: state.graphIngest }));
vi.mock("../src/lib/connectors/connector-ingest.js", () => ({
  ingestSourceAsKnowledge: state.sourceIngest,
  ingestRepoMetadata: state.metadataIngest,
  ingestDbSchema: vi.fn(),
}));
vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ search: state.search }),
}));
vi.mock("../src/lib/analysis/analysis-service.js", () => ({
  getLatestWebResearch: vi.fn(async () => ({ digests: [] })),
}));
vi.mock("../src/lib/docs-gen/grounding/domain-web-research.js", () => ({
  runDomainWebResearch: state.webResearch,
}));
vi.mock("../src/lib/docs-gen/generated-doc-publication.js", () => ({
  GENERATED_DOC_PUBLICATION_TASK_TYPE: "publish-generated-document",
  enqueueGeneratedDocPublication: state.publications,
  publishGeneratedDocRevision: state.publications,
  enqueueGeneratedDocDeletion: vi.fn(),
  generatedDocSyntheticDocumentId: (id: string) => `gendoc-${id}`,
}));
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

import { bootstrapScheduler, __resetSchedulerBootstrap } from "../src/lib/scheduler/index.js";
import { buildSchedulerHandlerOverrides } from "../src/lib/scheduler/handler-overrides.js";
import { SCHEDULER_DEFAULTS } from "../src/lib/scheduler/config.js";
import { createPrismaTaskStore } from "../src/lib/scheduler/task-store.js";
import { runRegenerationTask } from "../src/lib/docs-gen/incremental.js";
import { generateDocumentAsync } from "../src/routes/generated-docs.js";
import { prisma } from "../src/lib/prisma.js";
import { jobEvents } from "../src/lib/socket/job-events.js";
import { captureGenerationInputs } from "../src/lib/docs-gen/generation-inputs.js";
import { resolveEvidencePolicy } from "../src/lib/docs-gen/evidence-policy.js";
import {
  legacyGeneratedDocVersionManifest,
  parseGeneratedDocVersionManifest,
} from "../src/lib/docs-gen/generated-doc-provenance.js";
import type { RegenerationTask } from "../src/lib/docs-gen/regeneration-plan.js";
import type { TaskHandlerContext } from "../src/lib/scheduler/types.js";

let scheduler: ReturnType<typeof bootstrapScheduler>;
const document = () =>
  state.doc as unknown as Parameters<typeof resolveEvidencePolicy>[0] &
    Parameters<typeof captureGenerationInputs>[0];
const payload = () =>
  JSON.parse([...state.tasks.values()][0].payload as string) as RegenerationTask;
async function settle() {
  await vi.waitFor(
    () => expect(scheduler.queue.snapshot()).toMatchObject({ running: 0, queueDepth: 0 }),
    { timeout: 10000, interval: 10 },
  );
}
async function ingest(connectorId = "r") {
  const registration = scheduler.registry.get("refresh-repo-connector")!;
  await registration.handler({
    task: { projectId: "p", payload: { connectorId } },
    signal: new AbortController().signal,
    reportProgress: vi.fn(),
  } as unknown as TaskHandlerContext);
  await settle();
}
async function baseline() {
  const snapshot = await captureGenerationInputs(
    document(),
    await resolveEvidencePolicy(document()),
  );
  state.versions.push({
    version: 1,
    provenanceManifest: JSON.stringify({
      ...legacyGeneratedDocVersionManifest({
        projectId: "p",
        generatedDocumentId: "d",
        version: 1,
      }),
      inputSnapshot: snapshot,
    }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  state.tasks.clear();
  state.versions.length = 0;
  state.edges = [];
  state.chunks = [];
  state.activeUser = true;
  state.failCommit = false;
  state.failTask = false;
  state.mutation = null;
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
    autoUpdate: true,
    status: "ready",
    codeGraphHash: "old",
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
  state.graphIngest.mockResolvedValue({ filesParsed: 1, symbolsUpserted: 30 });
  state.sourceIngest.mockResolvedValue({ failures: 0, chunkCount: 2 });
  state.metadataIngest.mockResolvedValue({ failures: 0 });
  state.search.mockResolvedValue({ hits: [] });
  state.publications.mockResolvedValue({});
  state.webResearch.mockResolvedValue(undefined);
  state.stream.mockImplementation(async function* (messages) {
    if (state.mutation) {
      const mutation = state.mutation;
      state.mutation = null;
      mutation();
    }
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
  __resetSchedulerBootstrap();
  scheduler = bootstrapScheduler({
    handlerOverrides: buildSchedulerHandlerOverrides(),
    config: { ...SCHEDULER_DEFAULTS, retryBackoffMs: 1, retryBackoffMaxMs: 1 },
  });
});
afterEach(async () => {
  await scheduler.shutdown();
  vi.unstubAllEnvs();
});

describe("successful ingest regeneration (#1356)", () => {
  it.each(["cancelled", "completed", "failed"])(
    "task fixture preserves terminal %s against every late store transition",
    async (status) => {
      await ingest();
      const row = [...state.tasks.values()][0];
      Object.assign(row, { status, errorMessage: "original", progress: 73 });
      const before = { ...row };
      const store = createPrismaTaskStore();
      expect(await store.markRunning(row.id, 99, new Date())).toBeNull();
      for (const task of [
        await store.markRetrying(row.id, "late retry", new Date()),
        await store.markCompleted(row.id, { late: true }, new Date()),
        await store.markFailed(row.id, "late failure", new Date()),
        await store.markCancelled(row.id, "late cancellation", new Date()),
      ])
        expect(task.status).toBe(status);
      await store.updateProgress(row.id, 99);
      expect(state.tasks.get(row.id)).toEqual(before);
    },
  );

  it("task fixture increments persisted attempts and rejects a second running claim", async () => {
    await ingest();
    const row = [...state.tasks.values()][0];
    Object.assign(row, { status: "pending", attempts: 2 });
    const store = createPrismaTaskStore();
    expect(await store.markRunning(row.id, 1, new Date())).toMatchObject({
      status: "running",
      attempts: 3,
    });
    const before = { ...row };
    expect(await store.markRunning(row.id, 1, new Date())).toBeNull();
    expect(state.tasks.get(row.id)).toEqual(before);
    const snapshot = await prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    await store.markRetrying(row.id, "retry", new Date());
    expect(snapshot).toMatchObject({ status: "running", attempts: 3 });
    expect(state.tasks.get(row.id)).toMatchObject({ status: "pending", attempts: 3 });
    await expect(store.markRunning("missing", 1, new Date())).rejects.toThrow("Task not found");
    expect(state.tasks.has("missing")).toBe(false);
  });

  it("executes actual holistic generation, retains type/scope/warnings, and replays without a call or version", async () => {
    await ingest();
    expect(state.stream).toHaveBeenCalled();
    expect(state.versions).toHaveLength(1);
    const manifest = parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest);
    expect(manifest).toMatchObject({
      document: { scope: "repository", docType: "architecture" },
      inputSnapshot: { version: 1 },
      regeneration: { mode: "full" },
    });
    expect(state.doc.status).toBe("degraded");
    expect(state.doc.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "source-unavailable" })]),
    );
    expect(state.publications).toHaveBeenCalledTimes(1);
    const calls = state.stream.mock.calls.length;
    await ingest();
    await runRegenerationTask(payload(), new AbortController().signal);
    expect(state.stream).toHaveBeenCalledTimes(calls);
    expect(state.versions).toHaveLength(1);
    expect(state.tasks.size).toBe(2);
  });
  it("does not schedule failed graph/source/metadata ingestion", async () => {
    state.graphIngest.mockRejectedValueOnce(new Error("bad graph"));
    await expect(ingest()).rejects.toThrow("bad graph");
    state.sourceIngest.mockResolvedValueOnce({ failures: 1 });
    await ingest();
    state.metadataIngest.mockResolvedValueOnce({ failures: 1 });
    await ingest();
    expect(state.tasks.size).toBe(0);
    expect(state.stream).not.toHaveBeenCalled();
  });
  it("ignores unchanged inputs and unrelated repositories", async () => {
    await baseline();
    await ingest();
    state.symbols[25].contentHash = "different";
    await ingest("other");
    expect(state.tasks.size).toBe(0);
    expect(state.stream).not.toHaveBeenCalled();
  });
  it.each(["removal", "addition", "edge", "settings", "evidence"])(
    "detects %s across the full scoped input inventory",
    async (change) => {
      await baseline();
      if (change === "removal") state.symbols.splice(25, 1);
      if (change === "addition")
        state.symbols.push({ ...state.symbols[0], id: "new", qualifiedName: "NewClass" });
      if (change === "edge")
        state.edges.push({
          fromSymbol: state.symbols[1],
          toSymbol: null,
          toQualifiedName: "external",
          kind: "calls",
          filePath: "src/api.ts",
          line: 1,
          metadata: "{}",
          source: null,
        });
      if (change === "settings") vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "9000");
      if (change === "evidence")
        state.chunks.push({
          id: "c",
          documentId: "ref",
          position: 0,
          text: "changed reference",
          metadata: "{}",
          aclSubjects: "[]",
          document: {
            filename: "connector:repo:r:README.md",
            storagePath: "ref",
            aclSubjects: "[]",
          },
        });
      await ingest();
      expect(state.versions).toHaveLength(2);
      const manifest = parseGeneratedDocVersionManifest(state.versions[1].provenanceManifest);
      expect(manifest.regeneration?.mode).toBe("full");
      expect(manifest.regeneration?.changed.length).toBeGreaterThan(0);
      if (change === "removal")
        expect(
          manifest.regeneration?.changed.filter((key) => key.startsWith("symbol:")),
        ).toHaveLength(1);
    },
  );
  it("retries transient generation failure with the same durable task", async () => {
    state.failCommit = true;
    await ingest();
    expect(state.tasks.size).toBe(2);
    expect([...state.tasks.values()][0]).toMatchObject({ status: "completed", attempts: 2 });
    expect(state.versions).toHaveLength(1);
  });
  it("replays ingestion after an outbox failure without duplicate jobs", async () => {
    state.failTask = true;
    await expect(ingest()).rejects.toThrow("outbox unavailable");
    await ingest();
    await ingest();
    expect(state.tasks.size).toBe(2);
    expect(state.versions).toHaveLength(1);
  });
  it("revalidates the initiating user before any generation", async () => {
    state.activeUser = false;
    await expect(ingest()).resolves.toBeUndefined();
    expect(state.stream).not.toHaveBeenCalled();
    expect(state.tasks.size).toBe(0);
  });

  it("schedules the valid document after legacy policy, malformed scope and malformed manifest rows", async () => {
    vi.mocked(prisma.generatedDocument.findMany).mockResolvedValueOnce([
      { ...state.doc, id: "legacy", evidencePolicy: null },
      { ...state.doc, id: "bad-policy", evidencePolicy: '{"version":99}' },
      { ...state.doc, id: "bad-scope", scopeFilter: "null" },
      { ...state.doc, id: "bad-manifest" },
      { ...state.doc },
    ] as never);
    vi.mocked(prisma.generatedDocumentVersion.findFirst).mockResolvedValueOnce({
      version: 1,
      provenanceManifest: "{}",
    } as never);
    await ingest();
    expect(state.tasks.size).toBe(2);
    expect(payload().generatedDocumentId).toBe("d");
    expect(state.versions).toHaveLength(1);
    expect(state.publications).toHaveBeenCalledTimes(1);
  });

  it.each(["authorization", "capture", "manifest", "claim"])(
    "marks a pending manual generation failed after pre-claim %s failure",
    async (failure) => {
      state.doc.status = "pending";
      if (failure === "authorization") state.activeUser = false;
      if (failure === "capture") state.doc.scopeFilter = "{";
      if (failure === "manifest") state.versions.push({ version: 1, provenanceManifest: "{" });
      if (failure === "claim")
        vi.mocked(prisma.generatedDocument.updateMany).mockRejectedValueOnce(
          new Error("claim unavailable"),
        );
      await generateDocumentAsync("d", "p");
      expect(state.doc).toMatchObject({ status: "failed", codeGraphHash: "old" });
      expect(state.stream).not.toHaveBeenCalled();
      expect(jobEvents.failed).toHaveBeenCalledTimes(1);
      expect(state.versions).toHaveLength(failure === "manifest" ? 1 : 0);
    },
  );

  it("does not overwrite or broadcast failure for a concurrent manual generation", async () => {
    state.doc.status = "generating";
    state.doc.codeGraphHash = "other-claim";
    await generateDocumentAsync("d", "p");
    expect(state.doc).toMatchObject({ status: "generating", codeGraphHash: "other-claim" });
    expect(jobEvents.failed).not.toHaveBeenCalled();
    expect(state.stream).not.toHaveBeenCalled();
  });

  it.each(["generating", "pending", "ready", "deleted"])(
    "preserves a concurrently %s document on pre-claim failure",
    async (status) => {
      state.doc.status = "pending";
      vi.mocked(prisma.user.findFirst).mockImplementationOnce(async () => {
        state.doc.status = status;
        state.doc.updatedAt = new Date(Date.now() + 1000);
        if (status === "deleted") state.doc.deletedAt = new Date();
        return null;
      });
      await generateDocumentAsync("d", "p");
      expect(state.doc.status).toBe(status);
      expect(jobEvents.failed).not.toHaveBeenCalled();
    },
  );

  it("does not fail a manual job that loses its claim before a boundary failure", async () => {
    state.doc.status = "pending";
    vi.mocked(prisma.generatedDocument.findFirst)
      .mockResolvedValueOnce({ ...state.doc } as never)
      .mockImplementationOnce(async () => {
        state.doc.codeGraphHash = "other-claim";
        throw new Error("read failed");
      });
    await generateDocumentAsync("d", "p");
    expect(state.doc).toMatchObject({ status: "generating", codeGraphHash: "other-claim" });
    expect(jobEvents.failed).not.toHaveBeenCalled();
  });

  it.each(["old", null])(
    "fences the original pending claim hash %s even when timestamps collide",
    async (codeGraphHash) => {
      state.doc.status = "pending";
      state.doc.codeGraphHash = codeGraphHash;
      const updatedAt = state.doc.updatedAt;
      vi.mocked(prisma.user.findFirst).mockImplementationOnce(async () => {
        state.doc.codeGraphHash = "concurrent-job";
        return null;
      });
      await generateDocumentAsync("d", "p");
      expect(state.doc).toMatchObject({
        status: "pending",
        codeGraphHash: "concurrent-job",
        updatedAt,
      });
      expect(jobEvents.failed).not.toHaveBeenCalled();
      expect(state.stream).not.toHaveBeenCalled();
    },
  );

  it("terminates a pre-claim failure on an unchanged pending row with a null hash", async () => {
    state.doc.status = "pending";
    state.doc.codeGraphHash = null;
    state.activeUser = false;
    await generateDocumentAsync("d", "p");
    expect(state.doc).toMatchObject({
      status: "failed",
      codeGraphHash: null,
      errorMessage: "failed",
    });
    expect(jobEvents.failed).toHaveBeenCalledTimes(1);
  });
  it.each(["deleted", "revoked", "superseded"])("fences %s during generation", async (change) => {
    state.mutation = () => {
      if (change === "deleted") state.doc.deletedAt = new Date();
      if (change === "revoked") state.activeUser = false;
      if (change === "superseded") state.doc.codeGraphHash = "another-claim";
    };
    await ingest();
    expect(state.versions).toHaveLength(0);
    expect(state.publications).not.toHaveBeenCalled();
  });
  it("fences changed inputs then replans on durable retry instead of publishing stale content", async () => {
    const before = await captureGenerationInputs(
      document(),
      await resolveEvidencePolicy(document()),
    );
    state.mutation = () => {
      state.symbols[25].contentHash = "concurrent edit";
    };
    await ingest();
    expect(state.versions).toHaveLength(1);
    expect(
      parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest).inputSnapshot
        ?.fingerprint,
    ).not.toBe(before.fingerprint);
    expect(state.publications).toHaveBeenCalledTimes(1);
    expect(state.tasks.size).toBe(3);
  });
  it("regenerates only the section with changed complete prompt dependencies through ingest and the durable worker", async () => {
    await ingest();
    const first = parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest);
    expect(first.sectionSynthesis?.complete).toBe(true);
    const target = first.sectionSynthesis!.records[1];
    state.chunks.push({
      id: "c",
      documentId: "ref",
      position: 0,
      text: "New architectural evidence",
      metadata: "{}",
      aclSubjects: "[]",
      document: { filename: "connector:repo:r:README.md", storagePath: "ref", aclSubjects: "[]" },
    });
    state.search.mockImplementation(async (_project, query: string) => ({
      hits: query.includes(target.metadata.sectionLabel)
        ? [
            {
              documentId: "ref",
              chunkId: "c",
              filename: "connector:repo:r:README.md",
              text: "New architectural evidence",
            },
          ]
        : [],
    }));
    state.stream.mockClear();
    await ingest();
    expect(state.versions).toHaveLength(2);
    const second = parseGeneratedDocVersionManifest(state.versions[1].provenanceManifest);
    expect(second.regeneration).toMatchObject({ mode: "sections", sections: [target.sectionId] });
    const sectionCalls = state.stream.mock.calls.filter(([messages]) =>
      messages.at(-1).content.includes("section group now"),
    );
    expect(sectionCalls).toHaveLength(1);
    expect(second.sectionSynthesis!.records[0]).toEqual(first.sectionSynthesis!.records[0]);
    expect(state.doc.status).toBe("degraded");
    expect(state.publications).toHaveBeenCalledTimes(2);
  });
  it("retries the persisted publication independently without regenerating a duplicate revision", async () => {
    state.publications.mockRejectedValueOnce(new Error("publication unavailable"));
    await ingest();
    expect(state.versions).toHaveLength(1);
    expect(state.publications).toHaveBeenCalledTimes(2);
    expect([...state.tasks.values()][0]).toMatchObject({ status: "completed", attempts: 1 });
    expect([...state.tasks.values()][1]).toMatchObject({
      type: "publish-generated-document",
      status: "completed",
      attempts: 2,
    });
  });
  it("revalidates opt-in web research snapshots before committing production synthesis", async () => {
    state.doc.evidencePolicy = JSON.stringify({
      version: 1,
      principal: { kind: "initiating-user", userId: "u" },
      sharedDocumentIds: [],
      allowWebResearch: true,
    });
    await ingest();
    expect(state.webResearch).toHaveBeenCalledTimes(1);
    expect(state.versions).toHaveLength(1);
    expect(
      parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest).inputSnapshot?.items
        .web,
    ).toBeDefined();
  });
  it("rejects non-web source changes during opt-in research and retries current inputs", async () => {
    state.doc.evidencePolicy = JSON.stringify({
      version: 1,
      principal: { kind: "initiating-user", userId: "u" },
      sharedDocumentIds: [],
      allowWebResearch: true,
    });
    state.webResearch.mockImplementationOnce(async () => {
      state.symbols[25].contentHash = "research-race";
    });
    await ingest();
    expect(state.versions).toHaveLength(1);
    const current = await captureGenerationInputs(
      document(),
      await resolveEvidencePolicy(document()),
    );
    expect(
      parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest).inputSnapshot,
    ).toEqual(current);
    expect(state.publications).toHaveBeenCalledTimes(1);
  });
  it("replans superseded version envelopes without replaying obsolete generation", async () => {
    await ingest();
    const calls = state.stream.mock.calls.length;
    await runRegenerationTask({ ...payload(), expectedVersion: 20 }, new AbortController().signal);
    expect(state.stream).toHaveBeenCalledTimes(calls);
    expect(state.versions).toHaveLength(1);
  });
  it("rejects an aborted worker before synthesis", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runRegenerationTask(
        { projectId: "p", generatedDocumentId: "d", expectedVersion: 0, fingerprint: "old" },
        controller.signal,
      ),
    ).rejects.toThrow("Regeneration aborted");
    expect(state.stream).not.toHaveBeenCalled();
  });
  it("replans stale queued fingerprints rather than losing the ingest event", async () => {
    const snapshot = await captureGenerationInputs(
      document(),
      await resolveEvidencePolicy(document()),
    );
    state.symbols[25].contentHash = "new";
    await runRegenerationTask(
      {
        projectId: "p",
        generatedDocumentId: "d",
        expectedVersion: 0,
        fingerprint: snapshot.fingerprint,
      },
      new AbortController().signal,
    );
    await settle();
    expect(state.versions).toHaveLength(1);
    expect(
      parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest).inputSnapshot
        ?.fingerprint,
    ).not.toBe(snapshot.fingerprint);
  });
  it("is stable across regenerated SQL identifiers and symbol ordering", async () => {
    const before = await captureGenerationInputs(
      document(),
      await resolveEvidencePolicy(document()),
    );
    state.symbols.reverse().forEach((s, i) => {
      s.id = `recreated-${i}`;
      s.createdAt = new Date();
    });
    const after = await captureGenerationInputs(
      document(),
      await resolveEvidencePolicy(document()),
    );
    expect(after).toEqual(before);
  });
});
