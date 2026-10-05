/**
 * #858 — the DB-schema document's phase-2 prose calls are metered and stoppable.
 *
 * In #706 run 3 the database-schema document ran its prose batches on
 * `deepseek-flash`, but `generateTableDescriptions` called `provider.chat` and
 * dropped the response's usage: the calls reached neither `token_usages` nor the
 * run's cost ceiling, so they bypassed the project budget. These tests pin the
 * ledger write (same `docs-gen` agent step as every other docs-gen call), the
 * run-scope spend report, and that a stopped run (#855) neither calls the model
 * nor publishes a document.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOptions, ChatResponse } from "../src/lib/ai/types.js";
import type { DbTableInfo } from "@metis/shared";

const { chatSpy, recordUsageSpy } = vi.hoisted(() => ({
  chatSpy: vi.fn(),
  recordUsageSpy: vi.fn(),
}));

vi.mock("../src/lib/ai/index.js", () => ({
  loadAIConfig: vi.fn(() => ({})),
  buildProvider: () => ({
    key: "openai",
    model: "deepseek-flash",
    offline: false,
    chat: chatSpy,
  }),
}));

vi.mock("../src/lib/finops/index.js", () => ({
  recordUsage: (...args: unknown[]) => {
    recordUsageSpy(...args);
    return { totalTokens: 0, costCents: 0, costUsd: 0, persisted: Promise.resolve() };
  },
}));

const { mockInspect } = vi.hoisted(() => ({ mockInspect: vi.fn() }));
vi.mock("../src/lib/connectors/db/db-service.js", () => ({
  inspectDbConnector: mockInspect,
  getDbConnector: vi.fn(async () => ({ label: "miniflux" })),
}));

vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../src/lib/impact-analysis/used-schema-classifier.js", () => ({
  readUsageClassification: vi.fn(async () => []),
}));

import { synthesizeDbSchemaDocument } from "../src/lib/docs-gen/db-schema-synthesizer.js";
import { withGenerationScope, type GenerationScope } from "../src/lib/docs-gen/generation-scope.js";
import { UnpublishableGenerationError } from "../src/lib/docs-gen/generation-checkpoint.js";

function table(name: string): DbTableInfo {
  return {
    schema: "public",
    name,
    columns: [
      { name: "id", dataType: "bigint", isPrimaryKey: true, isForeignKey: false, nullable: false },
    ],
    foreignKeys: [],
  } as unknown as DbTableInfo;
}

function reply(names: string[]): ChatResponse {
  const descriptions = Object.fromEntries(names.map((n) => [n, `Stores ${n}.`]));
  return {
    content: JSON.stringify({ descriptions }),
    usage: {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    },
    model: "deepseek-flash",
    provider: "openai",
    finishReason: "stop",
  } as unknown as ChatResponse;
}

function scope(stopped: UnpublishableGenerationError | null = null) {
  const controller = new AbortController();
  const noteSpend = vi.fn();
  const s: GenerationScope = {
    docId: "doc-1",
    projectId: "p1",
    signal: controller.signal,
    stopError: () => stopped,
    noteSpend,
  };
  return { s, noteSpend, controller };
}

beforeEach(() => {
  chatSpy.mockReset();
  recordUsageSpy.mockReset();
  mockInspect.mockReset();
  mockInspect.mockResolvedValue({ tables: [table("feeds"), table("entries")] });
});

describe("#858 — DB-schema prose calls are metered", () => {
  it("records each prose call's usage on the ledger under the docs-gen agent step", async () => {
    chatSpy.mockResolvedValue(reply(["feeds", "entries"]));
    await synthesizeDbSchemaDocument("p1", "conn1", "actor1", "Database Schema");

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(recordUsageSpy).toHaveBeenCalledTimes(1);
    expect(recordUsageSpy.mock.calls[0]![0]).toMatchObject({
      projectId: "p1",
      agentStep: "docs-gen",
      provider: "openai",
      model: "deepseek-flash",
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    });
    expect(recordUsageSpy.mock.calls[0]![0].sessionId).toMatch(/^docs-db-schema-p1-/);
  });

  it("reports the spend to the run and passes the run's abort signal", async () => {
    chatSpy.mockResolvedValue(reply(["feeds", "entries"]));
    const { s, noteSpend, controller } = scope();
    await withGenerationScope(s, () =>
      synthesizeDbSchemaDocument("p1", "conn1", "actor1", "Database Schema"),
    );

    expect(noteSpend).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek-flash", inputTokens: 1200, outputTokens: 300 }),
    );
    const opts = chatSpy.mock.calls[0]![1] as ChatOptions;
    expect(opts.signal).toBeDefined();
    controller.abort();
    expect(opts.signal!.aborted).toBe(true);
  });

  it("a stopped run makes no model call and fails instead of publishing", async () => {
    chatSpy.mockResolvedValue(reply(["feeds", "entries"]));
    const stop = new UnpublishableGenerationError("aborted", "The generation was cancelled.");
    const { s } = scope(stop);
    await expect(
      withGenerationScope(s, () =>
        synthesizeDbSchemaDocument("p1", "conn1", "actor1", "Database Schema"),
      ),
    ).rejects.toBe(stop);
    expect(chatSpy).not.toHaveBeenCalled();
    expect(recordUsageSpy).not.toHaveBeenCalled();
  });

  it("records nothing when the provider reports no usage", async () => {
    chatSpy.mockResolvedValue({
      ...reply(["feeds", "entries"]),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    await synthesizeDbSchemaDocument("p1", "conn1", "actor1", "Database Schema");
    expect(recordUsageSpy).not.toHaveBeenCalled();
  });
});
