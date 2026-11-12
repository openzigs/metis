/**
 * #2326 — chat's automatic retrieval says when the index cannot be trusted:
 *   - a failed, empty, partial or in-progress index puts a status line in the
 *     model's context on the turn's retrieval, without the model calling a tool;
 *   - a retrieval error is an explicit statement naming the project and the
 *     class of failure (never the error text), and the capture records it;
 *   - a partial coverage reaches the model's context, not only the label;
 *   - the index facts are captured for the reply's grounding label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { search, findUnique, readStatus } = vi.hoisted(() => ({
  search: vi.fn(),
  findUnique: vi.fn(),
  readStatus: vi.fn(),
}));
vi.mock("../lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ search }),
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique },
    user: { findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
    userRole: { findMany: async () => [] },
  },
}));
vi.mock("../lib/ai/index-status.js", async (original) => ({
  ...(await original<typeof import("../lib/ai/index-status.js")>()),
  readProjectIndexStatus: readStatus,
}));

import type { ChatMessage } from "../lib/ai/types.js";
import type { ProjectIndexStatus } from "../lib/ai/index-status.js";
import { describeGrounding, withToolReads } from "../lib/ai/chat-grounding.js";
import { __resetConfigSingleton } from "../lib/config/config-service.js";
import type { FusedCodeDeps, RagContextCapture } from "./ai.js";

const { buildAutoRagContext, partialCoverageNote, retrievalFailedBlock, RETRIEVAL_FAILED_BLOCK } =
  await import("./ai.js");

const turn: ChatMessage[] = [{ role: "user", content: "Does the reader refresh feeds hourly?" }];
const deps = (): FusedCodeDeps => ({
  searcher: { search: vi.fn().mockResolvedValue([]) },
  lineLookup: { resolve: vi.fn().mockResolvedValue(new Map()) },
});
const hit = {
  chunkId: "k1",
  documentId: "d1",
  filename: "manual.md",
  position: 0,
  text: "Feeds refresh every 60 minutes.",
  score: 0.9,
  embeddingModel: "test",
  source: "upload" as const,
};

function status(over: Partial<ProjectIndexStatus> = {}): ProjectIndexStatus {
  return {
    projectId: "p1",
    projectName: "Acme Reader",
    state: "healthy",
    documents: 4,
    repos: [
      {
        label: "acme-app",
        commitSha: "c4d54f87",
        indexedAt: "2026-11-12T05:09:00.000Z",
        lastRun: "completed",
        symbols: 10,
        coverage: null,
        inProgress: false,
      },
    ],
    moreRepos: 0,
    ...over,
  };
}
const failedStatus = status({
  state: "failed",
  repos: [{ ...status().repos[0]!, lastRun: "failed", error: "authentication failed" }],
});

const capture = (): RagContextCapture => ({ contexts: [], sources: 0 });

beforeEach(() => {
  search.mockReset();
  findUnique.mockReset();
  findUnique.mockResolvedValue({ name: "Acme Reader" });
  readStatus.mockReset();
  readStatus.mockResolvedValue(status());
});

afterEach(() => {
  delete process.env.CHAT_INDEX_STATUS;
  __resetConfigSingleton();
});

describe("index status in chat retrieval (#2326)", () => {
  it("healthy: the block is exactly what it was, and the label gets the index facts", async () => {
    search.mockResolvedValue({ hits: [hit] });
    const cap = capture();
    const out = await buildAutoRagContext("p1", turn, "u1", deps(), cap);
    expect(out.startsWith("## Retrieved Knowledge (project-scoped RAG)")).toBe(true);
    expect(out).not.toContain("## Index status");
    expect(cap.index).toEqual({
      state: "healthy",
      repos: [
        {
          label: "acme-app",
          commitSha: "c4d54f87",
          indexedAt: "2026-11-12T05:09:00.000Z",
          lastRun: "completed",
        },
      ],
    });
    expect(readStatus).toHaveBeenCalledWith("p1");
  });

  it("failed index: a status line leads the context, even when the search found something", async () => {
    readStatus.mockResolvedValue(failedStatus);
    search.mockResolvedValue({ hits: [hit] });
    const out = await buildAutoRagContext("p1", turn, "u1", deps(), capture());
    expect(out.startsWith("## Index status\n")).toBe(true);
    expect(out).toMatch(/failed \(authentication failed\)/);
    expect(out).toMatch(/do not conclude the project lacks it/);
    expect(out).toContain("Feeds refresh every 60 minutes.");
  });

  it("never indexed: the status line stands alone where the block would be empty", async () => {
    readStatus.mockResolvedValue(
      status({ state: "never-indexed", documents: 0, repos: [], moreRepos: 0 }),
    );
    search.mockResolvedValue({ hits: [] });
    const out = await buildAutoRagContext("p1", turn, "u1", deps(), capture());
    expect(out).toMatch(/^## Index status\n.*nothing in it has been indexed yet/s);
  });

  it("partial and in progress: each is said in the context", async () => {
    search.mockResolvedValue({ hits: [] });
    readStatus.mockResolvedValue(
      status({
        state: "in-progress",
        repos: [{ ...status().repos[0]!, lastRun: "running", inProgress: true }],
      }),
    );
    expect(await buildAutoRagContext("p1", turn, "u1", deps(), capture())).toMatch(
      /"acme-app" is still being indexed/,
    );
    readStatus.mockResolvedValue(
      status({ state: "partial", repos: [{ ...status().repos[0]!, lastRun: "partial" }] }),
    );
    expect(await buildAutoRagContext("p1", turn, "u1", deps(), capture())).toMatch(
      /the index of repository "acme-app" is partial/,
    );
  });

  it("CHAT_INDEX_STATUS=false keeps the line out of the context, but not the label's facts", async () => {
    process.env.CHAT_INDEX_STATUS = "false";
    __resetConfigSingleton();
    readStatus.mockResolvedValue(failedStatus);
    search.mockResolvedValue({ hits: [] });
    const cap = capture();
    expect(await buildAutoRagContext("p1", turn, "u1", deps(), cap)).toBe("");
    expect(cap.index?.state).toBe("failed");
  });

  it("an unreadable status costs the turn its line, never its retrieval", async () => {
    readStatus.mockResolvedValue(null);
    search.mockResolvedValue({ hits: [hit] });
    const cap = capture();
    const out = await buildAutoRagContext("p1", turn, "u1", deps(), cap);
    expect(out).toContain("Feeds refresh every 60 minutes.");
    expect(cap.index).toBeUndefined();
  });

  it("retrieval throws: an explicit, classified statement, and no secret from the error", async () => {
    // A fake credential, joined at run time so the secret scanner does not read it as real.
    const at = "@";
    search.mockRejectedValue(
      new Error(
        `connect ECONNREFUSED 10.1.2.3:5432 postgres://metis:hunter2${at}db.internal/metis token=ghp_abc123`,
      ),
    );
    const cap = capture();
    const out = await buildAutoRagContext("p1", turn, "u1", deps(), cap);
    expect(out).toBe(retrievalFailedBlock("Acme Reader", "network error"));
    expect(out).toContain(RETRIEVAL_FAILED_BLOCK);
    expect(out).toContain(
      'Retrieval failed for "Acme Reader": network error. Do not conclude that the project\'s code ' +
        "or documents lack what the question asks about.",
    );
    expect(out).not.toMatch(/hunter2|ghp_|10\.1\.2\.3|db\.internal/);
    expect(cap).toMatchObject({ failed: true, failure: "network error", sources: 0 });

    // …and the reply's label says so, with the class and the index facts.
    const grounding = await describeGrounding("p1", cap, async () => "Acme Reader");
    expect(grounding).toMatchObject({
      status: "no-context",
      reason: "retrieval-failed",
      failure: "network error",
      index: { state: "healthy" },
    });
  });

  it("retrieval throws and the project name cannot be read: the statement still stands", async () => {
    search.mockRejectedValue(new Error("timeout"));
    findUnique.mockRejectedValue(new Error("db down"));
    const out = await buildAutoRagContext("p1", turn, "u1", deps(), capture());
    expect(out).toBe(retrievalFailedBlock("this project", "timed out"));
  });

  it("a partial coverage reaches the model's context", async () => {
    search.mockResolvedValue({
      hits: [hit],
      coverageWarning: {
        matchingChunks: 40,
        totalChunks: 100,
        currentModel: "m",
        mismatchedModels: ["old"],
      },
    });
    const cap = capture();
    const out = await buildAutoRagContext("p1", turn, "u1", deps(), cap);
    expect(out.endsWith(partialCoverageNote({ matchingChunks: 40, totalChunks: 100 }))).toBe(true);
    expect(out).toContain("only 40 of the 100 chunks");
    expect(cap.coverage).toEqual({ matchingChunks: 40, totalChunks: 100 });
  });

  it("the index facts survive the tools' reads on the label", async () => {
    search.mockResolvedValue({ hits: [] });
    readStatus.mockResolvedValue(failedStatus);
    const cap = capture();
    await buildAutoRagContext("p1", turn, "u1", deps(), cap);
    const label = withToolReads(await describeGrounding("p1", cap, async () => "Acme Reader"), 2);
    expect(label).toMatchObject({ status: "grounded", toolReads: 2, index: { state: "failed" } });
  });
});
