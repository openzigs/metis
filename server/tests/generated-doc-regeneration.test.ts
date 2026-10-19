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
  /** `CodeGraph.extractorUpgradedAt` of the one graph (#1071): set by an ingest that upgrades it. */
  extractorUpgradedAt: null as Date | null,
  /** `extractorUpgradedAt` of ANOTHER repository's graph in the same project; null: there is none. */
  otherGraphUpgradedAt: null as Date | null,
  /** Run one at each later model call of a generation, after `mutation`. */
  laterMutations: [] as Array<() => void>,
  /** What the next (mocked) ingest does to the graph before it returns, as the real one would. */
  duringIngest: null as null | (() => void),
  /** The one `GeneratedDocumentAcknowledgement` row of the document, when there is one. */
  ack: null as null | {
    documentId: string;
    version: number;
    upgradedAt: Date;
    fingerprint: string;
    graphs: string | null;
  },
  /**
   * A clock that only moves forward, one second a tick, so versions and upgrade
   * marks are ordered. Inside the #1071 block it is also what `new Date()` reads.
   */
  clock: 0,
  tick: (): Date => new Date(),
  mutation: null as null | (() => void),
  stream: vi.fn(),
  search: vi.fn(),
  publications: vi.fn(),
  sourceIngest: vi.fn(),
  graphIngest: vi.fn(),
  metadataIngest: vi.fn(),
  webResearch: vi.fn(),
  /** #1230 — whether the document lists approved requirements, and what they are. */
  readsApproved: false,
  approved: [] as Array<Record<string, unknown>>,
  /**
   * #1252 — the follow-up check a run asks for after it publishes. The real
   * check runs behind it, so what it queues is what the test sees.
   */
  noteProject: vi.fn(),
  /** #1252 — who calls the regenerate route; unset: an admin. */
  caller: null as null | Record<string, unknown>,
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
      // #1252 — in workspace `ws-p`, whose only member is `u` (the route's access check).
      findUnique: vi.fn(
        async (args?: {
          select?: { workspace?: { select?: { members?: { where?: { userId?: string } } } } };
        }) => ({
          name: "Project",
          workspaceId: "ws-p",
          workspace: {
            deletedAt: null,
            members:
              args?.select?.workspace?.select?.members?.where?.userId === "u" ? [{ id: "m" }] : [],
          },
        }),
      ),
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
    repoConnection: {
      findUnique: vi.fn(async ({ where }) => ({ id: where.id, projectId: "p" })),
      findFirst: vi.fn(async ({ where }) => (where.projectId === "p" ? { id: where.id } : null)),
    },
    codeGraph: {
      findFirst: vi.fn(async ({ where }) => ({ id: `g-${where.repoConnectionId}` })),
      findMany: vi.fn(async ({ where }: { where?: { id?: string } } = {}) =>
        [
          {
            id: "g-r",
            commitSha: "sha",
            extractorUpgradedAt: state.extractorUpgradedAt,
            repoConnection: { id: "r", projectId: "p", deletedAt: null },
          },
          ...(state.otherGraphUpgradedAt
            ? [
                {
                  id: "g-other",
                  commitSha: "sha",
                  extractorUpgradedAt: state.otherGraphUpgradedAt,
                  repoConnection: { id: "other", projectId: "p", deletedAt: null },
                },
              ]
            : []),
        ].filter((graph) => !where?.id || graph.id === where.id),
      ),
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
          // #1252 — each `OR` clause as the route writes them: a status, a
          // status not in a list, an older `updatedAt`, or no version at all.
          (where.OR &&
            !where.OR.some(
              (clause: {
                status?: string | { notIn: string[] };
                updatedAt?: { lt: Date };
                versions?: { none: object };
              }) =>
                (clause.status === undefined ||
                  (typeof clause.status === "string"
                    ? state.doc.status === clause.status
                    : !clause.status.notIn.includes(state.doc.status as string))) &&
                (!clause.updatedAt ||
                  new Date(state.doc.updatedAt as Date) < clause.updatedAt.lt) &&
                (!clause.versions || state.versions.length === 0),
            )) ||
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
        // What the database adds to a new row.
        const row = { createdAt: state.tick(), ...data };
        state.versions.push(row);
        return row;
      }),
    },
    generatedDocumentAcknowledgement: {
      findUnique: vi.fn(async () => (state.ack ? { ...state.ack } : null)),
      upsert: vi.fn(async ({ create, update }) => {
        state.ack = state.ack ? { ...state.ack, ...update } : { ...create };
        return { ...state.ack };
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
    // #246 — the grounders call `chat`. Without it every section's fact-check
    // threw, which used to pass silently; it now marks the section
    // "NOT fact-checked" and keeps it out of the reuse record.
    chat: vi.fn(async () => ({ content: '{"claims":[]}' })),
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
  settleCancelledGeneratedDocPublication: vi.fn(),
  enqueueGeneratedDocDeletion: vi.fn(),
  generatedDocSyntheticDocumentId: (id: string) => `gendoc-${id}`,
}));
// #1230 — the approved-requirements snapshot item, without a reader-layout BRD:
// only whether the document reads them and what they are is faked.
vi.mock("../src/lib/docs-gen/approved-requirements-section.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/lib/docs-gen/approved-requirements-section.js")
  >()),
  readsApprovedRequirements: () => state.readsApproved,
  loadApprovedRequirements: async () => state.approved.map((r) => ({ ...r })),
}));
// #1252 — the regenerate route, reached through its real handler: who may call
// it is the route tests' (`generated-doc-interrupted-generation`), not this file's.
// The project-access check is the real one: project `p` is in workspace
// `ws-p`, whose only member is `u`.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = state.caller ?? { userId: "u", username: "user", role: "admin", permissions: [] };
    next();
  },
  refreshAuthenticatedUser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));
// #1252 — the reader-layout gate is the module's own; what matters here is
// when a run asks for the check and what the check then does.
vi.mock("../src/lib/docs-gen/approved-requirements-staleness.js", () => ({
  noteProjectRequirementsChanged: state.noteProject,
  noteRequirementsChanged: vi.fn(),
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
import { generateDocumentAsync, generatedDocsRouter } from "../src/routes/generated-docs.js";
import express from "express";
import request from "supertest";
import { prisma } from "../src/lib/prisma.js";
import { jobEvents } from "../src/lib/socket/job-events.js";
import { captureGenerationInputs } from "../src/lib/docs-gen/generation-inputs.js";
import { resolveEvidencePolicy } from "../src/lib/docs-gen/evidence-policy.js";
import {
  legacyGeneratedDocVersionManifest,
  parseGeneratedDocVersionManifest,
} from "../src/lib/docs-gen/generated-doc-provenance.js";
import type { RegenerationTask } from "../src/lib/docs-gen/regeneration-plan.js";
import { sectionSynthesisSchema } from "../src/lib/docs-gen/section-reuse.js";
import type { TaskHandlerContext } from "../src/lib/scheduler/types.js";

/**
 * The code under test only awaits these Prisma calls, so a native Promise stands in for
 * Prisma's lazy PrismaPromise / fluent client in a mocked implementation.
 */
function awaitedImpl<F extends (...args: never[]) => PromiseLike<unknown>>(
  impl: (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>,
): F {
  return impl as unknown as F;
}

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
    createdAt: state.tick(),
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
  state.extractorUpgradedAt = null;
  state.otherGraphUpgradedAt = null;
  state.laterMutations = [];
  state.duringIngest = null;
  state.ack = null;
  state.clock = Date.UTC(2026, 0, 1);
  state.tick = () => {
    state.clock += 1000;
    if (vi.isFakeTimers()) vi.setSystemTime(state.clock);
    return new Date(state.clock);
  };
  state.failCommit = false;
  state.failTask = false;
  state.mutation = null;
  state.readsApproved = false;
  state.approved = [];
  state.noteProject.mockImplementation(async (projectId: string) => {
    const { checkIncrementalRegeneration } = await import("../src/lib/docs-gen/incremental.js");
    await checkIncrementalRegeneration(projectId, undefined, { approvedRequirementsOnly: true });
  });
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
  state.graphIngest.mockImplementation(async () => {
    const during = state.duringIngest;
    state.duringIngest = null;
    during?.();
    return { filesParsed: 1, symbolsUpserted: 30 };
  });
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
    } else state.laterMutations.shift()?.();
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

/**
 * #1071 (PR #1104, both reviews) — the first refresh after a deploy that
 * changes the code-graph extractor rewrites symbol names and edge bindings
 * with no repository change. `refreshRepoConnector` runs unattended, and a
 * document's input snapshot keys every symbol and edge by qualified name, so
 * without a rule this queued a `regenerate-generated-document` task for every
 * auto-updating document: model spend caused by an upgrade alone.
 *
 * The rule must also be NARROW. Its first form inferred the upgrade from the
 * baseline lacking a field that only newer snapshots carried — true of every
 * document published before the deploy, in every project, for ever — and so
 * swallowed every later change confined to graph rows. Here the evidence is
 * positive (the ingest that upgrades a graph marks it) and it is acknowledged
 * once.
 */
describe("a code-graph extractor upgrade spends no model calls by itself (#1071)", () => {
  /** What the #1071 upgrade does to stored rows: methods renamed, a call newly bound. */
  const rewriteGraph = (prefix = "src/api.ts::Api::") => {
    for (const s of state.symbols.slice(1)) {
      s.qualifiedName = String(s.qualifiedName).replace(/^.*(fn\d+)$/, `${prefix}$1`);
    }
    state.edges.push({
      fromSymbol: state.symbols[1],
      toSymbol: state.symbols[2],
      toQualifiedName: "fn2",
      kind: "calls",
      filePath: "src/api.ts",
      line: 3 + state.edges.length,
      metadata: '{"goResolution":"receiver-type"}',
      source: null,
    });
  };
  /** The next ingest upgrades the graph in place: it rewrites the rows AND marks the graph. */
  const upgradeOnNextIngest = (prefix?: string) => {
    state.duringIngest = () => {
      rewriteGraph(prefix);
      state.extractorUpgradedAt = state.tick();
    };
  };
  /** A change of graph rows with no source change and no upgrade: a lineage backfill, say. */
  const graphOnlyChange = (n: number) => {
    state.edges.push({
      fromSymbol: state.symbols[3],
      toSymbol: null,
      toQualifiedName: `orders_${n}`,
      kind: "references",
      filePath: "src/api.ts",
      line: 100 + n,
      metadata: null,
      source: "sql-lineage",
    });
  };
  const snapshot = async () =>
    captureGenerationInputs(document(), await resolveEvidencePolicy(document()));
  // The tests own the clock: `new Date()` in the code under test reads it, so
  // "before" and "after" are what the test says, never a race against the wall.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(state.clock);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  /** What version `index` is acknowledged to stand for; null when nothing is, or only an older version was. */
  const acknowledged = (index = 0) =>
    state.ack && state.ack.version === state.versions[index].version ? state.ack : null;
  const quiet = () => {
    expect(state.tasks.size).toBe(0);
    expect(state.stream).not.toHaveBeenCalled();
  };

  it("the upgrade refresh queues no task and calls no model, and acknowledges the new inputs", async () => {
    await baseline();
    const before = await snapshot();
    upgradeOnNextIngest();

    await ingest();

    // The premise: the upgrade did move the inputs fingerprint.
    const after = await snapshot();
    expect(after.fingerprint).not.toBe(before.fingerprint);
    quiet();
    expect(state.versions).toHaveLength(1);
    // Nothing was published: the version's manifest still says what it was generated from…
    expect(
      parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest).inputSnapshot
        ?.fingerprint,
    ).toBe(before.fingerprint);
    // …and beside it the upgraded inputs are acknowledged, against that upgrade's mark.
    expect(acknowledged()?.fingerprint).toBe(after.fingerprint);
    expect(acknowledged()?.upgradedAt).toEqual(state.extractorUpgradedAt);

    // Every later refresh of the unchanged repository stays quiet too.
    await ingest();
    await ingest();
    quiet();
    expect(state.versions).toHaveLength(1);
  });

  it("the NEXT refresh with a change confined to graph rows regenerates: the upgrade was acknowledged once", async () => {
    await baseline();
    upgradeOnNextIngest();
    await ingest();
    quiet();

    graphOnlyChange(1);
    await ingest();

    expect(state.versions).toHaveLength(2);
    expect(state.stream).toHaveBeenCalled();
    // And the one after that, against the new version, as any change does.
    graphOnlyChange(2);
    await ingest();
    expect(state.versions).toHaveLength(3);
  });

  it("a project no upgrade rewrote behaves as before: an old baseline and a graph-only change regenerate", async () => {
    // Every document published before this rule existed is in this state: no
    // mark on its graph, nothing acknowledged. Not Go, nothing upgraded.
    await baseline();
    expect(state.extractorUpgradedAt).toBeNull();

    graphOnlyChange(1);
    await ingest();

    expect(state.versions).toHaveLength(2);
    expect(state.stream).toHaveBeenCalled();
    expect(acknowledged()).toBeNull();
  });

  it("the same rewrite of the graph with NO upgrade mark regenerates", async () => {
    await baseline();
    state.duringIngest = () => rewriteGraph();
    await ingest();
    expect(state.versions).toHaveLength(2);
    expect(acknowledged()).toBeNull();
  });

  it("a mark OLDER than the document's version is not evidence for a later change", async () => {
    // The graph was upgraded, and the document was generated from it afterwards.
    state.extractorUpgradedAt = state.tick();
    await baseline();
    graphOnlyChange(1);
    await ingest();
    expect(state.versions).toHaveLength(2);
    expect(acknowledged()).toBeNull();
  });

  it("a second extractor upgrade later is suppressed once more, then changes regenerate again", async () => {
    await baseline();
    upgradeOnNextIngest();
    await ingest();
    const first = acknowledged()!;
    quiet();

    // A later release bumps the extractor again: another in-place rewrite.
    upgradeOnNextIngest("src/api.ts::ApiV2::");
    await ingest();
    quiet();
    expect(state.versions).toHaveLength(1);
    const second = acknowledged()!;
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.upgradedAt.getTime()).toBeGreaterThan(first.upgradedAt.getTime());
    expect(second.fingerprint).toBe((await snapshot()).fingerprint);

    // Once, not for good: the next graph-only change regenerates.
    graphOnlyChange(1);
    await ingest();
    expect(state.versions).toHaveLength(2);

    // And an upgrade after a NEW version is suppressed against that version.
    state.stream.mockClear();
    upgradeOnNextIngest("src/api.ts::ApiV3::");
    await ingest();
    expect(state.versions).toHaveLength(2);
    expect(state.stream).not.toHaveBeenCalled();
    expect(acknowledged(1)?.fingerprint).toBe((await snapshot()).fingerprint);
    graphOnlyChange(2);
    await ingest();
    expect(state.versions).toHaveLength(3);
  });

  /** Version `index`'s manifest as a release before per-graph attribution wrote it: no `graphs`. */
  const makeLegacy = (index = 0) => {
    const manifest = JSON.parse(state.versions[index].provenanceManifest as string);
    expect(manifest.inputSnapshot.graphs).toBeDefined();
    delete manifest.inputSnapshot.graphs;
    state.versions[index].provenanceManifest = JSON.stringify(manifest);
  };

  it("a version published BEFORE graphs were recorded: the upgrade of its one graph is still quiet, once", async () => {
    await baseline();
    makeLegacy();
    upgradeOnNextIngest();
    await ingest();
    quiet();
    expect(state.versions).toHaveLength(1);
    expect(acknowledged()?.fingerprint).toBe((await snapshot()).fingerprint);
    // The acknowledgement carries the graph's state, so the next change is told from the upgrade.
    expect(JSON.parse(acknowledged()!.graphs!)).toEqual((await snapshot()).graphs);
    graphOnlyChange(1);
    await ingest();
    expect(state.versions).toHaveLength(2);
  });

  it("a version published before graphs were recorded, on a graph nothing upgraded, regenerates as it always did", async () => {
    await baseline();
    makeLegacy();
    graphOnlyChange(1);
    await ingest();
    expect(state.versions).toHaveLength(2);
    expect(acknowledged()).toBeNull();
    // The new version records its graphs.
    expect(
      parseGeneratedDocVersionManifest(state.versions[1].provenanceManifest).inputSnapshot?.graphs,
    ).toEqual((await snapshot()).graphs);
  });

  it("a mark AHEAD of every later version's date is not evidence for a later change (clock skew)", async () => {
    await baseline();
    // The upgrading ingest ran on a host whose clock is an hour ahead.
    state.duringIngest = () => {
      rewriteGraph();
      state.extractorUpgradedAt = new Date(state.clock + 3_600_000);
    };
    await ingest();
    quiet();
    expect(acknowledged()?.upgradedAt.getTime()).toBeGreaterThan(state.clock);

    // A real change: version 2, published "before" that mark by the clocks.
    graphOnlyChange(1);
    await ingest();
    expect(state.versions).toHaveLength(2);
    expect((state.versions[1].createdAt as Date).getTime()).toBeLessThan(
      state.extractorUpgradedAt!.getTime(),
    );

    // And another, with no new upgrade: it regenerates. Compared with the
    // version's date, the stale mark would still look new and swallow it.
    graphOnlyChange(2);
    await ingest();
    expect(state.versions).toHaveLength(3);
    expect(acknowledged(2)).toBeNull();
  });

  it("a mark BEHIND the version's date is still that upgrade (clock skew the other way)", async () => {
    await baseline();
    state.duringIngest = () => {
      rewriteGraph();
      state.extractorUpgradedAt = new Date(state.clock - 3_600_000);
    };
    await ingest();
    quiet();
    expect(state.versions).toHaveLength(1);
    expect(acknowledged()?.fingerprint).toBe((await snapshot()).fingerprint);
  });

  it("an upgrade that changes nothing this document reads is adopted: the next graph-only change regenerates", async () => {
    await baseline();
    // The mark moves, the rows this document reads do not.
    state.duringIngest = () => {
      state.extractorUpgradedAt = state.tick();
    };
    await ingest();
    quiet();
    expect(acknowledged()?.upgradedAt).toEqual(state.extractorUpgradedAt);
    expect(acknowledged()?.fingerprint).toBe((await snapshot()).fingerprint);

    graphOnlyChange(1);
    await ingest();
    expect(state.versions).toHaveLength(2);
  });

  it("an upgrade that lands together with a real change still regenerates", async () => {
    await baseline();
    upgradeOnNextIngest();
    state.chunks.push({
      id: "c",
      documentId: "ref",
      position: 0,
      text: "changed reference",
      metadata: "{}",
      aclSubjects: "[]",
      document: {
        filename: "connector:repo:r:README.md",
        source: "repo",
        storagePath: "ref",
        aclSubjects: "[]",
      },
    });
    await ingest();
    expect(state.versions).toHaveLength(2);
    expect(acknowledged()).toBeNull();
  });

  it("the next real change after a quiet upgrade regenerates against the upgraded graph", async () => {
    await baseline();
    upgradeOnNextIngest();
    await ingest();
    expect(state.versions).toHaveLength(1);

    state.symbols[25].contentHash = "edited";
    state.chunks.push({
      id: "c2",
      documentId: "ref",
      position: 0,
      text: "edited source",
      metadata: "{}",
      aclSubjects: "[]",
      document: {
        filename: "connector:repo:r:src/api.ts",
        source: "repo",
        storagePath: "ref",
        aclSubjects: "[]",
      },
    });
    await ingest();
    expect(state.versions).toHaveLength(2);
    // The new version stands for the current inputs: nothing is masked after it.
    const after = parseGeneratedDocVersionManifest(state.versions[1].provenanceManifest);
    expect(after.inputSnapshot?.fingerprint).toBe((await snapshot()).fingerprint);
    graphOnlyChange(1);
    await ingest();
    expect(state.versions).toHaveLength(3);
  });

  it("a regeneration task already queued for the upgrade alone settles it when it runs: no model call", async () => {
    // A task queued for exactly this change by a scheduler that did not know
    // the rule, picked up afterwards: its fingerprint is current.
    await baseline();
    rewriteGraph();
    state.extractorUpgradedAt = state.tick();
    const current = await snapshot();
    await runRegenerationTask(
      {
        projectId: "p",
        generatedDocumentId: "d",
        expectedVersion: 1,
        fingerprint: current.fingerprint,
      },
      new AbortController().signal,
    );
    expect(state.stream).not.toHaveBeenCalled();
    expect(state.versions).toHaveLength(1);
    expect(state.doc.status).toBe("ready");
    expect(acknowledged()?.fingerprint).toBe(current.fingerprint);
  });

  it("control: the same queued task with no upgrade mark regenerates", async () => {
    await baseline();
    rewriteGraph();
    const current = await snapshot();
    await runRegenerationTask(
      {
        projectId: "p",
        generatedDocumentId: "d",
        expectedVersion: 1,
        fingerprint: current.fingerprint,
      },
      new AbortController().signal,
    );
    expect(state.stream).toHaveBeenCalled();
    expect(state.versions).toHaveLength(2);
  });

  it("an upgrade that lands while a document is generating does not stop or restart the run", async () => {
    const before = await snapshot();
    // The first model call of the run is when the upgrade's rewrite lands.
    state.mutation = () => {
      rewriteGraph();
      state.extractorUpgradedAt = state.tick();
    };
    await ingest();
    // One run, published once. Its manifest says what it captured…
    expect(state.versions).toHaveLength(1);
    expect(state.publications).toHaveBeenCalledTimes(1);
    expect(
      parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest).inputSnapshot
        ?.fingerprint,
    ).toBe(before.fingerprint);
    // …and the upgraded inputs it stands for are recorded beside it.
    expect(acknowledged()?.fingerprint).toBe((await snapshot()).fingerprint);
    const calls = state.stream.mock.calls.length;
    await ingest();
    expect(state.stream).toHaveBeenCalledTimes(calls);
    expect(state.versions).toHaveLength(1);
    // The window is closed: the next graph-only change regenerates.
    graphOnlyChange(1);
    await ingest();
    expect(state.versions).toHaveLength(2);
  });

  it("an upgrade of ANOTHER repository's graph is not evidence for this document", async () => {
    await baseline();
    // The project's other repository was upgraded just now; this document reads only `r`.
    state.otherGraphUpgradedAt = state.tick();
    graphOnlyChange(1);
    await ingest();
    expect(state.versions).toHaveLength(2);
    expect(acknowledged()).toBeNull();
  });

  it("an upgrade of ANOTHER repository's graph DURING the run is not evidence for a change in this one", async () => {
    // Mid-run: the project's other repository is upgraded, and this
    // document's own graph gets a lineage backfill. The run reads the mark of
    // its own graph only.
    state.otherGraphUpgradedAt = state.tick();
    state.mutation = () => {
      graphOnlyChange(1);
      state.otherGraphUpgradedAt = state.tick();
    };
    await ingest();
    // Changed inputs: that run published nothing, and the replanned one stands for the current inputs.
    expect(state.versions).toHaveLength(1);
    expect(state.publications).toHaveBeenCalledTimes(1);
    expect(
      parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest).inputSnapshot
        ?.fingerprint,
    ).toBe((await snapshot()).fingerprint);
    expect(acknowledged()).toBeNull();
    // The document's snapshot names its own graph and no other.
    expect(Object.keys((await snapshot()).graphs ?? {})).toHaveLength(1);
  });

  it("a mark that was already there when the run started is not evidence for a change DURING it", async () => {
    // The graph was upgraded some time ago. Now a lineage backfill lands mid-run.
    state.extractorUpgradedAt = state.tick();
    state.mutation = () => graphOnlyChange(1);
    await ingest();
    // Changed inputs: that run published nothing, and the replanned one stands for the current inputs.
    expect(state.versions).toHaveLength(1);
    expect(
      parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest).inputSnapshot
        ?.fingerprint,
    ).toBe((await snapshot()).fingerprint);
    expect(acknowledged()).toBeNull();
  });

  it("after an upgrade is tolerated mid-run, a LATER graph-only change with no new mark still stops the run", async () => {
    state.mutation = () => {
      rewriteGraph();
      state.extractorUpgradedAt = state.tick();
    };
    state.laterMutations = [() => graphOnlyChange(1)];
    await ingest();
    expect(state.versions).toHaveLength(1);
    // Published by the replanned run, from the inputs as they are now — not
    // by the first run with the second change acknowledged away.
    expect(
      parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest).inputSnapshot
        ?.fingerprint,
    ).toBe((await snapshot()).fingerprint);
    expect(acknowledged()).toBeNull();
  });

  it("an upgrade AND a source change landing mid-run are changed inputs", async () => {
    state.mutation = () => {
      rewriteGraph();
      state.extractorUpgradedAt = state.tick();
      state.symbols[25].contentHash = "edited";
      state.chunks.push({
        id: "c3",
        documentId: "ref",
        position: 0,
        text: "edited source",
        metadata: "{}",
        aclSubjects: "[]",
        document: {
          filename: "connector:repo:r:src/api.ts",
          source: "repo",
          storagePath: "ref",
          aclSubjects: "[]",
        },
      });
    };
    await ingest();
    expect(state.versions).toHaveLength(1);
    expect(
      parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest).inputSnapshot
        ?.fingerprint,
    ).toBe((await snapshot()).fingerprint);
    expect(acknowledged()).toBeNull();
  });

  it("control: a graph-only change mid-run with NO upgrade mark is changed inputs, as before", async () => {
    state.mutation = () => graphOnlyChange(1);
    await ingest();
    // The run that saw its inputs change published nothing; the replanned one did.
    expect(state.versions).toHaveLength(1);
    expect(
      parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest).inputSnapshot
        ?.fingerprint,
    ).toBe((await snapshot()).fingerprint);
    expect(acknowledged()).toBeNull();
  });
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
            source: "repo",
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
  it("retries a failed scheduling step without repeating the pull and ingest (#449)", async () => {
    state.failTask = true;
    // The refresh landed, so the scheduled refresh completes rather than failing
    // (a failed refresh task would be retried by re-running the whole ingest).
    await ingest();
    const retry = state.tasks.get("docs-regen-schedule:p:r");
    expect(retry).toMatchObject({ type: "schedule-regeneration", status: "completed" });
    // The retry task scheduled the regeneration, which produced the version…
    expect(state.versions).toHaveLength(1);
    expect(
      [...state.tasks.values()].filter((t) => t.type === "regenerate-generated-document"),
    ).toHaveLength(1);
    // …while the pull and every ingest step ran exactly once.
    expect(state.graphIngest).toHaveBeenCalledTimes(1);
    expect(state.sourceIngest).toHaveBeenCalledTimes(1);
    expect(state.metadataIngest).toHaveBeenCalledTimes(1);
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
      vi.mocked(prisma.user.findFirst).mockImplementationOnce(
        awaitedImpl<typeof prisma.user.findFirst>(async () => {
          state.doc.status = status;
          state.doc.updatedAt = new Date(Date.now() + 1000);
          if (status === "deleted") state.doc.deletedAt = new Date();
          return null;
        }),
      );
      await generateDocumentAsync("d", "p");
      expect(state.doc.status).toBe(status);
      expect(jobEvents.failed).not.toHaveBeenCalled();
    },
  );

  it("does not fail a manual job that loses its claim before a boundary failure", async () => {
    state.doc.status = "pending";
    vi.mocked(prisma.generatedDocument.findFirst)
      .mockResolvedValueOnce({ ...state.doc } as never)
      .mockImplementationOnce(
        awaitedImpl<typeof prisma.generatedDocument.findFirst>(async () => {
          state.doc.codeGraphHash = "other-claim";
          throw new Error("read failed");
        }),
      );
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
      vi.mocked(prisma.user.findFirst).mockImplementationOnce(
        awaitedImpl<typeof prisma.user.findFirst>(async () => {
          state.doc.codeGraphHash = "concurrent-job";
          return null;
        }),
      );
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
    const firstSections = sectionSynthesisSchema.parse(first.sectionSynthesis);
    const target = firstSections.records[1];
    state.chunks.push({
      id: "c",
      documentId: "ref",
      position: 0,
      text: "New architectural evidence",
      metadata: "{}",
      aclSubjects: "[]",
      document: {
        filename: "connector:repo:r:README.md",
        source: "repo",
        storagePath: "ref",
        aclSubjects: "[]",
      },
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
    expect(sectionSynthesisSchema.parse(second.sectionSynthesis).records[0]).toEqual(
      firstSections.records[0],
    );
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

/**
 * #1230 (PR #1249 review, blocking 2) — approving or editing a requirement
 * while a reader BRD is being generated is the normal sign-off workflow. The
 * approved requirements are among the document's inputs (it goes stale), but
 * the one section that reads them is rendered without a model, so the run in
 * progress does not stop for them: not between steps, not at the commit fence,
 * not during opt-in web research. The next check sees the change.
 */
describe("an approval during a reader BRD's generation (#1230)", () => {
  const approved = (title: string) => ({
    id: "req-1",
    title,
    body: "Body",
    type: "feature",
    priority: "high",
    reviewStatus: "approved",
    verdict: null,
    acceptanceCriteria: "[]",
    version: 1,
    updatedAt: new Date(),
    codeMappings: [],
    implementations: [],
  });
  const item = (manifest: unknown) =>
    parseGeneratedDocVersionManifest(manifest as string).inputSnapshot?.items.approvedRequirements;
  const current = async () =>
    (await captureGenerationInputs(document(), await resolveEvidencePolicy(document()))).items
      .approvedRequirements;

  /** How many versions were published each time the run asked for the check. */
  let publishedWhenNoted: number[] = [];
  beforeEach(() => {
    state.readsApproved = true;
    state.approved = [approved("Original")];
    publishedWhenNoted = [];
    const check = state.noteProject.getMockImplementation()!;
    state.noteProject.mockImplementation(async (projectId: string) => {
      publishedWhenNoted.push(state.versions.length);
      await check(projectId);
    });
  });

  it("does not stop the run: it publishes once, standing for the approvals it captured, then asks for the check", async () => {
    const before = await current();
    expect(before).toBeDefined();
    // The analyst edits the approved requirement during the first model call.
    state.mutation = () => {
      state.approved = [approved("Edited by the analyst")];
    };
    await ingest();
    const after = await current();
    expect(after).not.toBe(before);
    // Published once by the first run (a stopped run's replan would stand for
    // `after`), and only then did it ask for the check.
    expect(item(state.versions[0].provenanceManifest)).toBe(before);
    expect(state.noteProject).toHaveBeenCalledWith("p");
    expect(publishedWhenNoted).toEqual([1]);
    // #1252 (PR #1249 review, N1) — what that check queued brought the document
    // up to date: one more version, standing for the edit, with no second
    // `ingest()` in this test. That run saw no change of its own, so it asked
    // for nothing more.
    await vi.waitFor(() => expect(state.versions).toHaveLength(2), { timeout: 10000 });
    await settle();
    expect(state.versions).toHaveLength(2);
    expect(item(state.versions[1].provenanceManifest)).toBe(after);
    expect(state.noteProject).toHaveBeenCalledTimes(1);
  });

  it("asks for no follow-up check when the approvals did not change during the run", async () => {
    await ingest();
    expect(state.versions).toHaveLength(1);
    expect(state.noteProject).not.toHaveBeenCalled();
  });

  it("control: a source change at the same moment still stops the run", async () => {
    const before = await current();
    state.mutation = () => {
      state.approved = [approved("Edited by the analyst")];
      state.symbols[25].contentHash = "edited";
    };
    await ingest();
    expect(state.versions).toHaveLength(1);
    // The replanned run published, standing for the inputs as they are now.
    expect(item(state.versions[0].provenanceManifest)).not.toBe(before);
    expect(item(state.versions[0].provenanceManifest)).toBe(await current());
  });

  it("does not throw away opt-in web research either", async () => {
    state.doc.evidencePolicy = JSON.stringify({
      version: 1,
      principal: { kind: "initiating-user", userId: "u" },
      sharedDocumentIds: [],
      allowWebResearch: true,
    });
    state.webResearch.mockImplementationOnce(async () => {
      state.approved = [approved("Approved during research")];
    });
    await ingest();
    // One research pass: the run did not throw and retry.
    expect(state.webResearch).toHaveBeenCalledTimes(1);
    expect(state.versions).toHaveLength(1);
    expect(state.publications).toHaveBeenCalledTimes(1);
  });
});

/**
 * #1252 (PR #1267 review, blocking 1) — an out-of-date reader BRD without
 * auto-update is regenerated from the banner through POST /regenerate. Its
 * approved requirements alone moved, and the Approved Requirements section is
 * rendered from the stored rows with no model, so the run must reuse every
 * model-written section from the latest version rather than pay to write the
 * whole document again.
 */
describe("regenerating an out-of-date reader BRD reuses its model-written sections (#1252)", () => {
  const approved = (title: string) => ({
    id: "req-1",
    title,
    body: "Body",
    type: "feature",
    priority: "high",
    reviewStatus: "approved",
    verdict: null,
    acceptanceCriteria: "[]",
    version: 1,
    updatedAt: new Date(),
    codeMappings: [],
    implementations: [],
  });
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use("/projects/:projectId/docs", generatedDocsRouter());
    return a;
  };
  const sectionCalls = () =>
    state.stream.mock.calls.filter(([messages]) =>
      /Section group: \*\*/.test(messages.at(-1).content as string),
    ).length;

  beforeEach(() => {
    vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "reader");
    state.caller = null;
    state.readsApproved = true;
    state.approved = [approved("Original")];
    state.doc.title = "Business requirements";
    state.doc.scopeFilter = JSON.stringify({
      repoConnectorId: "r",
      docType: "business-requirements",
    });
  });

  it("rebuilds only Approved Requirements: no model-written section is synthesized again", async () => {
    await ingest();
    expect(state.versions).toHaveLength(1);
    expect(sectionCalls()).toBeGreaterThan(0);
    const first = parseGeneratedDocVersionManifest(state.versions[0].provenanceManifest);

    // A document the analyst regenerates by hand, whose approvals then moved.
    state.doc.autoUpdate = false;
    state.approved = [approved("Edited by the analyst")];
    state.stream.mockClear();

    const res = await request(app()).post("/projects/p/docs/d/regenerate").send({});
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(state.versions).toHaveLength(2), { timeout: 10000 });

    expect(sectionCalls()).toBe(0);
    const second = parseGeneratedDocVersionManifest(state.versions[1].provenanceManifest);
    expect(second.regeneration).toMatchObject({ mode: "sections" });
    const rebuilt = (second.regeneration as { sections: string[] }).sections;
    expect(rebuilt).toHaveLength(1);
    // Every other section's record is the first version's, as written then.
    const before = sectionSynthesisSchema.parse(first.sectionSynthesis).records;
    const after = sectionSynthesisSchema.parse(second.sectionSynthesis).records;
    const unchanged = (records: typeof before) =>
      records.filter((r) => !rebuilt.includes(r.sectionId));
    expect(unchanged(after).length).toBeGreaterThan(0);
    expect(unchanged(after)).toEqual(unchanged(before));
    expect(String(state.versions[1].content)).toContain("Edited by the analyst");
  });

  it("is refused (404) to a caller outside the project's workspace, and starts nothing", async () => {
    await ingest();
    state.doc.autoUpdate = false;
    state.approved = [approved("Edited by the analyst")];
    state.stream.mockClear();
    state.caller = {
      userId: "outsider",
      role: "reader",
      workspaces: ["ws-other"],
      permissions: [],
    };

    const res = await request(app()).post("/projects/p/docs/d/regenerate").send({});
    expect(res.status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.versions).toHaveLength(1);
    expect(state.stream).not.toHaveBeenCalled();
  });
});
