/**
 * #2343 — an ingest a person asked for ends with a toast and a bell item for
 * them: ready, held in quarantine for review, or failed. One enqueue is one
 * announcement however many retries it took; an ingest nobody asked for (no
 * `notifyUserId`) stays quiet; one left pending for a later retry is not over.
 *
 * The knowledge service is a fake that writes the document row the way the
 * real one does; the notifier is a spy (its own suites cover the writes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  projectId: string;
  filename: string;
  status: string;
  indexState: string | null;
  errorMessage: string | null;
  deletedAt: Date | null;
}
const documents = new Map<string, Row>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    document: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const d = documents.get(where.id);
        return d && !d.deletedAt ? d : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const next = { ...documents.get(where.id)!, ...data };
        documents.set(where.id, next);
        return next;
      }),
    },
  },
}));
const dispatchJobOutcome = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/notifications/job-notify.js", () => ({ dispatchJobOutcome }));

const { IngestQueue, ingestOutcome } = await import("../src/lib/rag/ingest-queue.js");
type KS = import("../src/lib/rag/knowledge-service.js").KnowledgeService;

/** A knowledge service whose ingest leaves the row as `result` says. */
function knowledgeEnding(result: Partial<Row>, failFirst = 0): KS {
  let calls = 0;
  return {
    ingestDocument: vi.fn(async (id: string) => {
      calls += 1;
      if (calls <= failFirst) throw new Error("transient");
      documents.set(id, { ...documents.get(id)!, ...result });
      return { documentId: id, status: "ready", chunkCount: 1 };
    }),
  } as unknown as KS;
}

function seed(id: string): void {
  documents.set(id, {
    id,
    projectId: "proj-1",
    filename: "brief.docx",
    status: "pending",
    indexState: "pending",
    errorMessage: null,
    deletedAt: null,
  });
}

beforeEach(() => documents.clear());
afterEach(() => vi.clearAllMocks());

describe("ingestOutcome", () => {
  it("reads the outcome from the row the ingest wrote", () => {
    expect(ingestOutcome({ status: "failed", indexState: "pending" })).toBe("failed");
    expect(ingestOutcome({ status: "ready", indexState: "quarantined" })).toBe("awaiting-review");
    expect(ingestOutcome({ status: "ready", indexState: "indexed" })).toBe("completed");
    expect(ingestOutcome({ status: "pending", indexState: "pending" })).toBeNull();
  });
});

describe("IngestQueue announces the outcome to the uploader (#2343)", () => {
  it("a quarantined document: waiting for review, named by its file", async () => {
    seed("d1");
    const queue = new IngestQueue({
      knowledge: knowledgeEnding({ status: "ready", indexState: "quarantined" }),
      concurrency: 1,
    });
    await queue.enqueue("d1", { priority: "manual", notifyUserId: "u-1" });
    await queue.onIdle();
    expect(dispatchJobOutcome).toHaveBeenCalledTimes(1);
    expect(dispatchJobOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "document-ingest",
        jobId: "d1",
        projectId: "proj-1",
        userId: "u-1",
        outcome: "awaiting-review",
        subject: "brief.docx",
      }),
    );
  });

  it("an auto-approved document is ready; retries end in ONE announcement", async () => {
    seed("d2");
    const queue = new IngestQueue({
      knowledge: knowledgeEnding({ status: "ready", indexState: "indexed" }, 1),
      concurrency: 1,
      maxAttempts: 3,
      retryBaseMs: 1,
    });
    await queue.enqueue("d2", { notifyUserId: "u-1" });
    await queue.onIdle();
    expect(dispatchJobOutcome).toHaveBeenCalledTimes(1);
    expect(dispatchJobOutcome.mock.calls[0][0].outcome).toBe("completed");
  });

  it("a document that failed every attempt is announced as failed", async () => {
    seed("d3");
    const queue = new IngestQueue({
      knowledge: knowledgeEnding({}, 99),
      concurrency: 1,
      maxAttempts: 2,
      retryBaseMs: 1,
    });
    await queue.enqueue("d3", { notifyUserId: "u-1" });
    await queue.onIdle();
    expect(dispatchJobOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "d3", outcome: "failed" }),
    );
  });

  it("each enqueue is its own run: a re-upload is announced again", async () => {
    seed("d4");
    const queue = new IngestQueue({
      knowledge: knowledgeEnding({ status: "ready", indexState: "indexed" }),
      concurrency: 1,
    });
    await queue.enqueue("d4", { notifyUserId: "u-1" });
    await queue.onIdle();
    documents.set("d4", { ...documents.get("d4")!, status: "failed" });
    await queue.enqueue("d4", { notifyUserId: "u-1" });
    await queue.onIdle();
    const keys = dispatchJobOutcome.mock.calls.map((c) => c[0].dedupeKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("stays quiet with no one to tell, and for an ingest left pending", async () => {
    seed("d5");
    seed("d6");
    const quiet = new IngestQueue({
      knowledge: knowledgeEnding({ status: "ready", indexState: "indexed" }),
      concurrency: 1,
    });
    await quiet.enqueue("d5");
    await quiet.onIdle();
    const pending = new IngestQueue({
      knowledge: knowledgeEnding({ status: "pending" }),
      concurrency: 1,
    });
    await pending.enqueue("d6", { notifyUserId: "u-1" });
    await pending.onIdle();
    expect(dispatchJobOutcome).not.toHaveBeenCalled();
  });

  it("a second requester of a document already in flight is told too", async () => {
    seed("d8");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const knowledge = {
      ingestDocument: vi.fn(async (id: string) => {
        await gate;
        documents.set(id, { ...documents.get(id)!, status: "ready", indexState: "indexed" });
        return { documentId: id, status: "ready", chunkCount: 1 };
      }),
    } as unknown as KS;
    const queue = new IngestQueue({ knowledge, concurrency: 1 });
    await queue.enqueue("d8", { notifyUserId: "u-1" });
    // Queued again while the first ingest runs: one ingest, both told.
    await queue.enqueue("d8", { notifyUserId: "u-2" });
    await queue.enqueue("d8", { notifyUserId: "u-1" });
    release();
    await queue.onIdle();
    expect(knowledge.ingestDocument).toHaveBeenCalledTimes(1);
    expect(dispatchJobOutcome.mock.calls.map((c) => c[0].userId).sort()).toEqual(["u-1", "u-2"]);
  });

  it("a document deleted meanwhile is not announced", async () => {
    seed("d7");
    const queue = new IngestQueue({
      knowledge: knowledgeEnding({ status: "ready", deletedAt: new Date() }),
      concurrency: 1,
    });
    await queue.enqueue("d7", { notifyUserId: "u-1" });
    await queue.onIdle();
    expect(dispatchJobOutcome).not.toHaveBeenCalled();
  });
});
