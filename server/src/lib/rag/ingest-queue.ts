/**
 * Background ingest queue for document RAG processing (issue #133).
 *
 * Decouples HTTP upload latency from the comparatively expensive embedding +
 * chunking pipeline. Upload routes mark a document as `queued` and return
 * 202; this module drains the queue at `INGEST_CONCURRENCY` parallelism and
 * surfaces transitions over Socket.IO via the KnowledgeService emit hook.
 *
 * Design notes:
 *  - Backed by `p-queue` so we get a tested concurrency primitive plus
 *    per-task priority, which lets the URL/text/multipart routes share a
 *    single queue without starving each other.
 *  - Exponential backoff retry (default: 3 attempts, 500 ms base). Failures
 *    after the final attempt mark the document `failed` with the last
 *    error message — same terminal state as a synchronous ingest crash.
 *  - State machine: pending → queued → processing → ready | failed.
 *    "processing" is owned by KnowledgeService; the queue only manages
 *    pending/queued/failed transitions and forwards processing/ready/failed
 *    events through the same emit hook.
 *  - Static `getIngestQueue` singleton + `__resetIngestQueueSingleton`
 *    matches the rest of the lib/rag/* modules so tests stay isolated.
 */
import PQueue from "p-queue";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import {
  getKnowledgeService,
  type KnowledgeEvent,
  type KnowledgeService,
} from "./knowledge-service.js";

const log = createChildLogger("ingest-queue");

export type IngestPriority = "manual" | "default" | "bulk";

const PRIORITY_VALUES: Record<IngestPriority, number> = {
  // p-queue runs *higher* priority first.
  manual: 10,
  default: 5,
  bulk: 1,
};

export interface IngestQueueOptions {
  knowledge?: KnowledgeService;
  emit?: (event: KnowledgeEvent) => void;
  /** Override env-derived concurrency. */
  concurrency?: number;
  /** Override env-derived retry attempts (>=1). */
  maxAttempts?: number;
  /** Base ms for exponential backoff (attempt^2 * base). */
  retryBaseMs?: number;
}

export interface EnqueueOptions {
  priority?: IngestPriority;
  /** Project id is read from the row when enqueuing; this is for telemetry. */
  reason?: string;
}

function intEnv(name: string, fallback: number, min = 1, max = 32): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function noopEmit(): void {
  /* default */
}

export class IngestQueue {
  private readonly queue: PQueue;
  private readonly knowledge: KnowledgeService;
  private readonly emit: (event: KnowledgeEvent) => void;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  /**
   * Best-effort de-dup so repeated upload-route calls for the same document
   * don't pile up multiple concurrent ingest attempts.
   */
  private readonly inflight = new Set<string>();

  constructor(opts: IngestQueueOptions = {}) {
    const concurrency = opts.concurrency ?? intEnv("INGEST_CONCURRENCY", 2, 1, 32);
    this.queue = new PQueue({ concurrency });
    this.knowledge = opts.knowledge ?? getKnowledgeService();
    this.emit = opts.emit ?? noopEmit;
    this.maxAttempts = Math.max(opts.maxAttempts ?? intEnv("INGEST_MAX_ATTEMPTS", 3, 1, 10), 1);
    this.retryBaseMs = Math.max(opts.retryBaseMs ?? intEnv("INGEST_RETRY_BASE_MS", 500, 1), 1);
  }

  /** Number of tasks currently running. */
  get pending(): number {
    return this.queue.pending;
  }

  /** Number of tasks waiting for a worker. */
  get size(): number {
    return this.queue.size;
  }

  /** Resolve when the queue has fully drained (used by tests + shutdown). */
  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }

  /**
   * Mark a freshly-uploaded document as queued and schedule its ingest.
   * Returns immediately so the HTTP route can respond with 202.
   */
  async enqueue(documentId: string, opts: EnqueueOptions = {}): Promise<void> {
    if (this.inflight.has(documentId)) {
      log.debug("enqueue: duplicate suppressed", { documentId });
      return;
    }
    this.inflight.add(documentId);

    const doc = await prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, projectId: true, status: true },
    });
    if (!doc) {
      this.inflight.delete(documentId);
      throw new Error(`Document ${documentId} not found (cannot enqueue)`);
    }
    // Only push pending/failed documents into the queue. Already-ready or
    // processing rows would either re-do work or race the live worker.
    if (doc.status !== "pending" && doc.status !== "queued" && doc.status !== "failed") {
      this.inflight.delete(documentId);
      log.debug("enqueue: skipped non-queueable status", {
        documentId,
        status: doc.status,
      });
      return;
    }

    await prisma.document.update({
      where: { id: documentId },
      data: { status: "queued", errorMessage: null },
    });
    this.safeEmit({
      type: "document:status",
      projectId: doc.projectId,
      documentId,
      status: "queued",
      attempt: 0,
    });

    const priority = PRIORITY_VALUES[opts.priority ?? "default"];
    this.queue
      .add(() => this.runWithRetry(documentId, doc.projectId), { priority })
      .catch((err) => {
        // p-queue rejects only if the wrapper itself throws. runWithRetry
        // already swallows everything, so this is genuinely unexpected.
        log.error("ingest queue task crashed", { documentId, error: (err as Error).message });
      })
      .finally(() => {
        this.inflight.delete(documentId);
      });
  }

  /**
   * Drive the ingest with exponential backoff retry. Final failure marks the
   * document `failed` with the last error message. KnowledgeService is the
   * source of truth for processing/ready/failed transitions; we only own the
   * queued + retry-scheduling events.
   */
  private async runWithRetry(documentId: string, projectId: string): Promise<void> {
    let attempt = 0;
    let lastError: Error | undefined;
    while (attempt < this.maxAttempts) {
      attempt += 1;
      try {
        await this.knowledge.ingestDocument(documentId);
        log.info("ingest succeeded", { documentId, attempt });
        return;
      } catch (err) {
        lastError = err as Error;
        log.warn("ingest attempt failed", {
          documentId,
          attempt,
          error: lastError.message,
        });
        if (attempt >= this.maxAttempts) break;
        const delay = this.retryBaseMs * attempt * attempt;
        this.safeEmit({
          type: "document:status",
          projectId,
          documentId,
          status: "queued",
          attempt,
          errorMessage: lastError.message,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    // Final fallthrough — surface the failure on the document row even if
    // KnowledgeService didn't (e.g. a thrown error before its own marker).
    try {
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: "failed",
          errorMessage: lastError?.message ?? "ingest failed after retries",
        },
      });
    } catch (writeErr) {
      log.error("failed to record ingest failure", {
        documentId,
        error: (writeErr as Error).message,
      });
    }
    this.safeEmit({
      type: "document:status",
      projectId,
      documentId,
      status: "failed",
      attempt,
      errorMessage: lastError?.message,
    });
  }

  private safeEmit(event: KnowledgeEvent): void {
    try {
      this.emit(event);
    } catch {
      /* never break the queue on emitter errors */
    }
  }
}

let singleton: IngestQueue | null = null;

export function getIngestQueue(): IngestQueue {
  if (!singleton) singleton = new IngestQueue();
  return singleton;
}

/**
 * Wire the singleton with an external emit hook (e.g. Socket.IO) and
 * optionally override knowledge service. Called once from `createServer`.
 */
export function configureIngestQueue(opts: IngestQueueOptions): void {
  singleton = new IngestQueue(opts);
}

/** Test seam — drop the singleton between tests. */
export function __resetIngestQueueSingleton(): void {
  singleton = null;
}
