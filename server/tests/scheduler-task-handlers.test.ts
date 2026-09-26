/**
 * Task handler registry — registration + built-in handlers.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_TASK_TYPES,
  InMemoryTaskHandlerRegistry,
  registerBuiltInHandlers,
} from "../src/lib/scheduler/task-handlers.js";
import type { TaskHandlerContext, TaskRecord } from "../src/lib/scheduler/types.js";

function makeCtx(
  payload: Record<string, unknown>,
  projectId: string | null = null,
): TaskHandlerContext {
  const task: TaskRecord = {
    id: "t1",
    scheduledJobId: "j1",
    projectId,
    type: "x",
    trigger: "scheduled",
    status: "running",
    priority: 5,
    payload,
    result: null,
    errorMessage: null,
    progress: null,
    attempts: 1,
    maxAttempts: 1,
    scheduledFor: null,
    startedAt: new Date(),
    completedAt: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { task, signal: new AbortController().signal, reportProgress: vi.fn(), log: vi.fn() };
}

describe("InMemoryTaskHandlerRegistry", () => {
  it("registers and retrieves handlers; warns on overwrite", () => {
    const reg = new InMemoryTaskHandlerRegistry();
    const handler = vi.fn();
    reg.register({ type: "x", description: "x", handler });
    expect(reg.get("x")?.handler).toBe(handler);
    const handler2 = vi.fn();
    reg.register({ type: "x", description: "x", handler: handler2 });
    expect(reg.get("x")?.handler).toBe(handler2);
    expect(reg.list().map((r) => r.type)).toContain("x");
  });
});

describe("regenerate-generated-document (#1356)", () => {
  const payload = {
    projectId: "p1",
    generatedDocumentId: "doc1",
    expectedVersion: 0,
    fingerprint: "hash1",
  };

  it("forwards the validated payload and exact cancellation signal and returns the document id", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    const regenerateGeneratedDocument = vi
      .fn<(payload: Record<string, unknown>, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn(), regenerateGeneratedDocument });
    const ctx = makeCtx(payload, "p1");
    const registration = reg.get("regenerate-generated-document")!;
    expect(registration.defaultTimeoutMs).toBe(7_200_000);
    await expect(registration.handler(ctx)).resolves.toEqual({ generatedDocumentId: "doc1" });
    expect(regenerateGeneratedDocument).toHaveBeenCalledExactlyOnceWith(payload, ctx.signal);
    expect(regenerateGeneratedDocument.mock.calls[0][1]).toBe(ctx.signal);
  });

  it.each([
    {},
    { ...payload, extra: "not allowed" },
    { ...payload, projectId: "" },
    { ...payload, generatedDocumentId: "" },
    { ...payload, fingerprint: "" },
    { ...payload, expectedVersion: -1 },
    { ...payload, expectedVersion: 1.5 },
    { ...payload, expectedVersion: "1" },
    { ...payload, fingerprint: null },
  ])("rejects an invalid payload without invoking the dependency: %j", async (invalid) => {
    const reg = new InMemoryTaskHandlerRegistry();
    const regenerateGeneratedDocument = vi.fn();
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn(), regenerateGeneratedDocument });
    await expect(
      reg.get("regenerate-generated-document")!.handler(makeCtx(invalid, "p1")),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(regenerateGeneratedDocument).not.toHaveBeenCalled();
  });

  it.each(["other-project", null])("rejects task project %s before dispatch", async (projectId) => {
    const reg = new InMemoryTaskHandlerRegistry();
    const regenerateGeneratedDocument = vi.fn();
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn(), regenerateGeneratedDocument });
    await expect(
      reg.get("regenerate-generated-document")!.handler(makeCtx(payload, projectId)),
    ).rejects.toThrow("Regeneration project mismatch");
    expect(regenerateGeneratedDocument).not.toHaveBeenCalled();
  });

  it("fails clearly when the dependency is missing", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn() });
    await expect(
      reg.get("regenerate-generated-document")!.handler(makeCtx(payload, "p1")),
    ).rejects.toThrow("regenerate-generated-document handler not wired");
  });

  it("propagates downstream failure for queue retry", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    const error = new Error("generation failed");
    registerBuiltInHandlers(reg, {
      httpWebhookHandler: vi.fn(),
      regenerateGeneratedDocument: vi.fn().mockRejectedValue(error),
    });
    await expect(
      reg.get("regenerate-generated-document")!.handler(makeCtx(payload, "p1")),
    ).rejects.toBe(error);
  });
});

describe("registerBuiltInHandlers", () => {
  it("registers all v1 task types", () => {
    const reg = new InMemoryTaskHandlerRegistry();
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn() });
    for (const type of BUILT_IN_TASK_TYPES) {
      expect(reg.get(type)).toBeDefined();
    }
  });

  it("dispatches refresh-repo-connector to its dep", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    const refreshRepoConnector = vi.fn(async () => ({ refreshed: true }));
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn(), refreshRepoConnector });
    const result = await reg.get("refresh-repo-connector")!.handler(makeCtx({ connectorId: "c1" }));
    expect(refreshRepoConnector).toHaveBeenCalledWith("c1", expect.any(AbortSignal));
    expect(result).toMatchObject({ connectorId: "c1", refreshed: true });
  });

  it("fails fast when refresh-repo-connector dep is missing", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn() });
    await expect(
      reg.get("refresh-repo-connector")!.handler(makeCtx({ connectorId: "c1" })),
    ).rejects.toThrow(/not wired/);
  });

  it("requires payload.connectorId for refresh-repo-connector", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn(), refreshRepoConnector: vi.fn() });
    await expect(reg.get("refresh-repo-connector")!.handler(makeCtx({}))).rejects.toThrow(
      /connectorId is required/,
    );
  });

  it("accepts task.projectId fallback for rerun-analysis", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    const rerunAnalysis = vi.fn(async () => ({ ok: true }));
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn(), rerunAnalysis });
    await reg.get("rerun-analysis")!.handler(makeCtx({}, "p1"));
    expect(rerunAnalysis).toHaveBeenCalledWith("p1", expect.any(AbortSignal));
  });

  it("rerun-analysis requires a project id and a wired handler", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn() });

    await expect(reg.get("rerun-analysis")!.handler(makeCtx({}))).rejects.toThrow(
      /projectId is required/,
    );

    await expect(reg.get("rerun-analysis")!.handler(makeCtx({}, "p1"))).rejects.toThrow(
      /not wired/,
    );
  });

  it("publish-batch handler requires batchId", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    const publishBatch = vi.fn(async () => ({}));
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn(), publishBatch });
    await expect(reg.get("publish-batch")!.handler(makeCtx({}))).rejects.toThrow(/batchId/);
    await reg.get("publish-batch")!.handler(makeCtx({ batchId: "b1" }));
    expect(publishBatch).toHaveBeenCalledWith("b1", expect.any(AbortSignal));
  });

  it("publish-generated-document validates payload and dispatches to its dep", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    const publishGeneratedDocument = vi.fn(async () => ({ status: "published", chunkCount: 3 }));
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn(), publishGeneratedDocument });

    await expect(reg.get("publish-generated-document")!.handler(makeCtx({}))).rejects.toThrow(
      /generatedDocumentId is required/,
    );

    const result = await reg.get("publish-generated-document")!.handler(
      makeCtx({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 4,
        revisionId: "rev-4",
      }),
    );

    expect(publishGeneratedDocument).toHaveBeenCalledWith(
      "doc-1",
      "proj-1",
      4,
      "rev-4",
      expect.any(AbortSignal),
      { onProgress: expect.any(Function), finalAttempt: true },
    );
    expect(result).toMatchObject({
      generatedDocumentId: "doc-1",
      projectId: "proj-1",
      version: 4,
      revisionId: "rev-4",
      status: "published",
      chunkCount: 3,
    });
  });

  it("#189 — publish-generated-document persists embed progress and flags the final attempt", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    const publishGeneratedDocument = vi.fn(
      async (
        _doc: string,
        _project: string,
        _version: number,
        _revision: string,
        _signal: AbortSignal,
        options?: {
          onProgress?: (p: { step: string; current: number; total: number }) => void;
          finalAttempt?: boolean;
        },
      ) => {
        options?.onProgress?.({ step: "embed", current: 32, total: 64 });
        return { status: "published", finalAttempt: options?.finalAttempt };
      },
    );
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn(), publishGeneratedDocument });
    const payload = {
      generatedDocumentId: "doc-1",
      projectId: "proj-1",
      version: 4,
      revisionId: "rev-4",
    };
    const first = makeCtx(payload);
    first.task.attempts = 1;
    first.task.maxAttempts = 3;
    await expect(reg.get("publish-generated-document")!.handler(first)).resolves.toMatchObject({
      finalAttempt: false,
    });
    expect(first.reportProgress).toHaveBeenCalledWith({
      step: "publish-generated-document:embed",
      current: 32,
      total: 64,
    });
    const last = makeCtx(payload);
    last.task.attempts = 3;
    last.task.maxAttempts = 3;
    await expect(reg.get("publish-generated-document")!.handler(last)).resolves.toMatchObject({
      finalAttempt: true,
    });
  });

  it("publish-generated-document validates projectId, version, revisionId, and wiring", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn() });
    const handler = reg.get("publish-generated-document")!.handler;

    await expect(
      handler(
        makeCtx({
          generatedDocumentId: "doc-1",
          version: 4,
          revisionId: "rev-4",
        }),
      ),
    ).rejects.toThrow(/projectId is required/);

    await expect(
      handler(
        makeCtx({
          generatedDocumentId: "doc-1",
          projectId: "proj-1",
          version: 0,
          revisionId: "rev-4",
        }),
      ),
    ).rejects.toThrow(/version must be a positive integer/);

    await expect(
      handler(
        makeCtx({
          generatedDocumentId: "doc-1",
          projectId: "proj-1",
          version: 4,
        }),
      ),
    ).rejects.toThrow(/revisionId is required/);

    await expect(
      handler(
        makeCtx({
          generatedDocumentId: "doc-1",
          projectId: "proj-1",
          version: 4,
          revisionId: "rev-4",
        }),
      ),
    ).rejects.toThrow(/not wired/);
  });

  it("refresh-db-connector-schema dispatches to its dep", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    const refreshDbConnectorSchema = vi.fn(async () => ({ rows: 0 }));
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn(), refreshDbConnectorSchema });
    await reg.get("refresh-db-connector-schema")!.handler(makeCtx({ connectorId: "db1" }));
    expect(refreshDbConnectorSchema).toHaveBeenCalledWith("db1", expect.any(AbortSignal));
  });

  it("refresh-db-connector-schema fails fast when its dep is missing", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn() });
    await expect(
      reg.get("refresh-db-connector-schema")!.handler(makeCtx({ connectorId: "db1" })),
    ).rejects.toThrow(/not wired/);
  });

  it("refresh-db-connector-schema requires connectorId", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    registerBuiltInHandlers(reg, {
      httpWebhookHandler: vi.fn(),
      refreshDbConnectorSchema: vi.fn(async () => ({ rows: 0 })),
    });

    await expect(reg.get("refresh-db-connector-schema")!.handler(makeCtx({}))).rejects.toThrow(
      /connectorId is required/,
    );
  });

  it("publish-batch fails fast when its dep is missing", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn() });
    await expect(reg.get("publish-batch")!.handler(makeCtx({ batchId: "b1" }))).rejects.toThrow(
      /not wired/,
    );
  });

  it("scanner.run-scan requires scanId and a wired handler", async () => {
    const reg = new InMemoryTaskHandlerRegistry();
    registerBuiltInHandlers(reg, { httpWebhookHandler: vi.fn() });

    await expect(reg.get("scanner.run-scan")!.handler(makeCtx({}))).rejects.toThrow(/scanId/);
    await expect(
      reg.get("scanner.run-scan")!.handler(makeCtx({ scanId: "scan-1" })),
    ).rejects.toThrow(/not wired/);
  });
});
