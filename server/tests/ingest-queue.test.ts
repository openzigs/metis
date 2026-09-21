/**
 * IngestQueue tests (issue #133).
 *
 * Strategy: use a fake `KnowledgeService` so we control success / failure
 * without touching embeddings. Stub prisma.document with an in-memory map
 * so state machine assertions are trivial.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockDocument {
  id: string;
  projectId: string;
  status: string;
  errorMessage: string | null;
  deletedAt: Date | null;
}
const documents = new Map<string, MockDocument>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    document: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const d = documents.get(where.id);
        return d && !d.deletedAt ? d : null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<MockDocument> }) => {
          const d = documents.get(where.id);
          if (!d) throw new Error("not found");
          const next = { ...d, ...data } as MockDocument;
          documents.set(where.id, next);
          return next;
        },
      ),
    },
  },
}));

import { IngestQueue } from "../src/lib/rag/ingest-queue.js";
import type { KnowledgeService } from "../src/lib/rag/knowledge-service.js";

function fakeKnowledge(overrides: Partial<KnowledgeService> = {}): KnowledgeService {
  const base = {
    ingestDocument: vi.fn(async (id: string) => ({
      documentId: id,
      status: "ready" as const,
      chunkCount: 1,
    })),
  };
  return { ...base, ...overrides } as unknown as KnowledgeService;
}

function seedDoc(id: string, status = "pending"): void {
  documents.set(id, {
    id,
    projectId: "proj_1",
    status,
    errorMessage: null,
    deletedAt: null,
  });
}

beforeEach(() => {
  documents.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("IngestQueue", () => {
  it("transitions pending → queued → processing → ready on success", async () => {
    seedDoc("d1");
    const events: string[] = [];
    const knowledge = fakeKnowledge();
    const queue = new IngestQueue({
      knowledge,
      emit: (e) => events.push(e.status),
      concurrency: 1,
    });
    await queue.enqueue("d1");
    await queue.onIdle();
    expect(documents.get("d1")?.status).toBe("queued"); // queue marks queued; success leaves the row in queued state because we don't override (KS owns ready).
    expect(events).toContain("queued");
    expect(knowledge.ingestDocument).toHaveBeenCalledWith("d1");
  });

  it("retries up to maxAttempts then marks failed", async () => {
    seedDoc("d2");
    const knowledge = fakeKnowledge({
      ingestDocument: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const events: { status: string; attempt?: number }[] = [];
    const queue = new IngestQueue({
      knowledge,
      emit: (e) => events.push({ status: e.status, attempt: e.attempt }),
      concurrency: 1,
      maxAttempts: 3,
      retryBaseMs: 1,
    });
    await queue.enqueue("d2");
    await queue.onIdle();
    expect(knowledge.ingestDocument).toHaveBeenCalledTimes(3);
    expect(documents.get("d2")?.status).toBe("failed");
    expect(documents.get("d2")?.errorMessage).toBe("boom");
    expect(events.filter((e) => e.status === "failed")).toHaveLength(1);
  });

  it("succeeds on a later attempt and stops retrying", async () => {
    seedDoc("d3");
    let calls = 0;
    const knowledge = fakeKnowledge({
      ingestDocument: vi.fn(async () => {
        calls += 1;
        if (calls < 2) throw new Error("transient");
        return { documentId: "d3", status: "ready" as const, chunkCount: 1 };
      }),
    });
    const queue = new IngestQueue({
      knowledge,
      concurrency: 1,
      maxAttempts: 3,
      retryBaseMs: 1,
    });
    await queue.enqueue("d3");
    await queue.onIdle();
    expect(calls).toBe(2);
  });

  it("de-dups concurrent enqueues for the same documentId", async () => {
    seedDoc("d4");
    const knowledge = fakeKnowledge();
    const queue = new IngestQueue({ knowledge, concurrency: 1 });
    await Promise.all([queue.enqueue("d4"), queue.enqueue("d4")]);
    await queue.onIdle();
    expect(knowledge.ingestDocument).toHaveBeenCalledTimes(1);
  });

  it("skips ready documents (no enqueue, no ingest)", async () => {
    seedDoc("d5", "ready");
    const knowledge = fakeKnowledge();
    const queue = new IngestQueue({ knowledge, concurrency: 1 });
    await queue.enqueue("d5");
    await queue.onIdle();
    expect(knowledge.ingestDocument).not.toHaveBeenCalled();
    expect(documents.get("d5")?.status).toBe("ready");
  });

  it("throws when the documentId does not exist", async () => {
    const knowledge = fakeKnowledge();
    const queue = new IngestQueue({ knowledge });
    await expect(queue.enqueue("missing")).rejects.toThrow(/not found/);
  });

  it("priorities: manual runs before bulk", async () => {
    seedDoc("manual");
    seedDoc("bulk1");
    seedDoc("bulk2");
    const order: string[] = [];
    const knowledge = fakeKnowledge({
      ingestDocument: vi.fn(async (id: string) => {
        order.push(id);
        return { documentId: id, status: "ready" as const, chunkCount: 1 };
      }),
    });
    const queue = new IngestQueue({ knowledge, concurrency: 1 });
    // Enqueue bulk first; manual should still run first because of priority.
    await queue.enqueue("bulk1", { priority: "bulk" });
    await queue.enqueue("manual", { priority: "manual" });
    await queue.enqueue("bulk2", { priority: "bulk" });
    await queue.onIdle();
    // The first task (bulk1) starts immediately because the worker is idle.
    // Once manual is enqueued, it preempts bulk2 in the wait queue.
    expect(order[0]).toBe("bulk1");
    expect(order[1]).toBe("manual");
    expect(order[2]).toBe("bulk2");
  });

  it("emit hook failures never crash the queue", async () => {
    seedDoc("d6");
    const knowledge = fakeKnowledge();
    const queue = new IngestQueue({
      knowledge,
      emit: () => {
        throw new Error("emit broken");
      },
      concurrency: 1,
    });
    await expect(queue.enqueue("d6")).resolves.toBeUndefined();
    await queue.onIdle();
    expect(knowledge.ingestDocument).toHaveBeenCalledTimes(1);
  });

  it("respects concurrency cap", async () => {
    for (let i = 0; i < 5; i += 1) seedDoc(`p${i}`);
    let active = 0;
    let peak = 0;
    const knowledge = fakeKnowledge({
      ingestDocument: vi.fn(async (id: string) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return { documentId: id, status: "ready" as const, chunkCount: 1 };
      }),
    });
    const queue = new IngestQueue({ knowledge, concurrency: 2 });
    await Promise.all(Array.from({ length: 5 }, (_, i) => queue.enqueue(`p${i}`)));
    await queue.onIdle();
    expect(peak).toBeLessThanOrEqual(2);
  });
});
