/**
 * Epic #156 (#146) — Async background runner.
 *
 * Drains queued `BackgroundRun` rows at a fixed concurrency using `p-queue`.
 * Each run is dispatched to a registered `RunHandler` keyed by `kind`. The
 * runner emits `bg-run:status` and `bg-run:step` events through the supplied
 * emitter (Socket.IO in production, no-op in tests) and threads the lifecycle
 * hook bus from #114 (`sessionStart` / `sessionEnd`).
 *
 * Cooperative cancellation: handlers receive an `AbortSignal` and a
 * `nextSteer()` helper that returns any queued `RunMessage` rows since the
 * last call. Handlers MUST `signal.aborted` between steps so cancel/pause
 * land in finite time.
 *
 * Restart recovery: rows in `running` whose `heartbeatAt` is older than
 * `BG_HEARTBEAT_TIMEOUT_MS` (default 60s) are reset to `queued` on
 * `recoverStaleRuns()` (called once at server boot).
 */
import PQueue from "p-queue";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getHookBus } from "../hooks/bus.js";

const log = createChildLogger("async-runner");

export type RunStatus = "queued" | "running" | "paused" | "cancelled" | "failed" | "succeeded";

export type RunKind = "analysis" | "chat" | "browse" | "custom";

export interface RunHandlerContext {
  runId: string;
  projectId: string;
  sessionId: string | null;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  /** Drain any queued steer messages (FIFO). Marks them delivered. */
  nextSteer: () => Promise<Array<{ id: string; role: string; content: string }>>;
  /** Heartbeat ping — call between steps for restart-recovery accounting. */
  heartbeat: () => Promise<void>;
  /** Emit a step event over Socket.IO. */
  emitStep: (kind: string, content: string) => void;
}

export type RunHandler = (
  ctx: RunHandlerContext,
) => Promise<{ result?: unknown; score?: number | null }>;

export interface RunnerEmitter {
  status: (run: {
    id: string;
    projectId: string;
    status: RunStatus;
    error?: string | null;
  }) => void;
  step: (e: { runId: string; kind: string; content: string; ts: number }) => void;
}

const noopEmitter: RunnerEmitter = {
  status: () => {},
  step: () => {},
};

export interface AsyncRunnerOptions {
  concurrency?: number;
  emitter?: RunnerEmitter;
  heartbeatTimeoutMs?: number;
}

export class AsyncRunner {
  private readonly queue: PQueue;
  private readonly emitter: RunnerEmitter;
  private readonly handlers = new Map<string, RunHandler>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly paused = new Set<string>();
  private stopped = false;
  readonly heartbeatTimeoutMs: number;

  constructor(opts: AsyncRunnerOptions = {}) {
    const concurrency = opts.concurrency ?? intEnv("BG_CONCURRENCY", 4, 1, 32);
    this.queue = new PQueue({ concurrency });
    this.emitter = opts.emitter ?? noopEmitter;
    this.heartbeatTimeoutMs =
      opts.heartbeatTimeoutMs ?? intEnv("BG_HEARTBEAT_TIMEOUT_MS", 60_000, 1_000, 600_000);
  }

  registerHandler(kind: string, handler: RunHandler): void {
    this.handlers.set(kind, handler);
  }

  hasHandler(kind: string): boolean {
    return this.handlers.has(kind);
  }

  /** Queue size + currently running. */
  stats(): { size: number; running: number } {
    return { size: this.queue.size, running: this.queue.pending };
  }

  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }

  stop(): void {
    this.stopped = true;
    for (const c of this.controllers.values()) c.abort();
  }

  /** Reset stale `running` rows back to `queued` so a fresh boot picks them up. */
  async recoverStaleRuns(): Promise<number> {
    const cutoff = new Date(Date.now() - this.heartbeatTimeoutMs);
    const stale = await prisma.backgroundRun.findMany({
      where: {
        status: "running",
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: cutoff } }],
      },
      select: { id: true },
    });
    if (stale.length === 0) return 0;
    await prisma.backgroundRun.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { status: "queued", error: "RECOVERED_FROM_STALE_RUNNING" },
    });
    log.info("Recovered stale runs", { count: stale.length });
    return stale.length;
  }

  /** Persist a new BackgroundRun row and dispatch it. */
  async submit(input: {
    projectId: string;
    sessionId?: string | null;
    kind: RunKind | string;
    payload?: Record<string, unknown>;
    priority?: number;
    runGroupId?: string | null;
  }): Promise<{ id: string }> {
    const row = await prisma.backgroundRun.create({
      data: {
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        kind: input.kind,
        payload: JSON.stringify(input.payload ?? {}),
        priority: input.priority ?? 0,
        runGroupId: input.runGroupId ?? null,
      },
    });
    this.dispatch(row.id);
    return { id: row.id };
  }

  /** Dispatch an existing queued row through `p-queue`. Idempotent. */
  dispatch(runId: string): void {
    if (this.stopped) return;
    void this.queue.add(() => this.execute(runId));
  }

  /** Drain all queued rows (e.g. after recovery). */
  async dispatchQueued(): Promise<void> {
    const rows = await prisma.backgroundRun.findMany({
      where: { status: "queued" },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    for (const r of rows) this.dispatch(r.id);
  }

  async cancel(runId: string): Promise<boolean> {
    const ctrl = this.controllers.get(runId);
    if (ctrl) ctrl.abort();
    const row = await prisma.backgroundRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, projectId: true },
    });
    if (!row) return false;
    if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled")
      return false;
    await prisma.backgroundRun.update({
      where: { id: runId },
      data: { status: "cancelled", completedAt: new Date() },
    });
    this.emitter.status({ id: runId, projectId: row.projectId, status: "cancelled" });
    return true;
  }

  async pause(runId: string): Promise<boolean> {
    const row = await prisma.backgroundRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, projectId: true },
    });
    if (!row || row.status !== "running") return false;
    this.paused.add(runId);
    await prisma.backgroundRun.update({
      where: { id: runId },
      data: { status: "paused" },
    });
    this.emitter.status({ id: runId, projectId: row.projectId, status: "paused" });
    return true;
  }

  async resume(runId: string): Promise<boolean> {
    const row = await prisma.backgroundRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, projectId: true },
    });
    if (!row || row.status !== "paused") return false;
    this.paused.delete(runId);
    await prisma.backgroundRun.update({
      where: { id: runId },
      data: { status: "queued" },
    });
    this.emitter.status({ id: runId, projectId: row.projectId, status: "queued" });
    this.dispatch(runId);
    return true;
  }

  /** Whether a run is currently paused. Public for tests. */
  isPaused(runId: string): boolean {
    return this.paused.has(runId);
  }

  private async execute(runId: string): Promise<void> {
    const row = await prisma.backgroundRun.findUnique({ where: { id: runId } });
    if (!row || row.status !== "queued") return;
    const handler = this.handlers.get(row.kind);
    if (!handler) {
      await prisma.backgroundRun.update({
        where: { id: runId },
        data: {
          status: "failed",
          error: `NO_HANDLER:${row.kind}`,
          completedAt: new Date(),
        },
      });
      this.emitter.status({
        id: runId,
        projectId: row.projectId,
        status: "failed",
        error: `NO_HANDLER:${row.kind}`,
      });
      return;
    }

    const ctrl = new AbortController();
    this.controllers.set(runId, ctrl);
    const now = new Date();
    await prisma.backgroundRun.update({
      where: { id: runId },
      data: { status: "running", startedAt: now, heartbeatAt: now, error: null },
    });
    this.emitter.status({ id: runId, projectId: row.projectId, status: "running" });

    let payload: Record<string, unknown> = {};
    try {
      payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
    } catch {
      payload = {};
    }

    const ctx: RunHandlerContext = {
      runId,
      projectId: row.projectId,
      sessionId: row.sessionId,
      payload,
      signal: ctrl.signal,
      heartbeat: async () => {
        await prisma.backgroundRun.update({
          where: { id: runId },
          data: { heartbeatAt: new Date() },
        });
      },
      nextSteer: async () => {
        const queued = await prisma.runMessage.findMany({
          where: { runId, status: "queued" },
          orderBy: { ord: "asc" },
        });
        if (queued.length === 0) return [];
        await prisma.runMessage.updateMany({
          where: { id: { in: queued.map((q) => q.id) } },
          data: { status: "delivered", deliveredAt: new Date() },
        });
        return queued.map((q) => ({ id: q.id, role: q.role, content: q.content }));
      },
      emitStep: (kind, content) => this.emitter.step({ runId, kind, content, ts: Date.now() }),
    };

    try {
      if (row.sessionId) {
        await getHookBus().emit("sessionStart", {
          sessionId: row.sessionId,
          projectId: row.projectId,
          userId: "system",
          provider: "background",
          model: row.kind,
        });
      }
      const out = await handler(ctx);
      await prisma.backgroundRun.update({
        where: { id: runId },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          result: out.result === undefined ? null : JSON.stringify(out.result),
          score: out.score ?? null,
        },
      });
      this.emitter.status({ id: runId, projectId: row.projectId, status: "succeeded" });
      if (row.sessionId) {
        await getHookBus().emit("sessionEnd", {
          sessionId: row.sessionId,
          projectId: row.projectId,
          userId: "system",
          totalTokens: 0,
          status: "succeeded",
        });
      }
    } catch (err) {
      const aborted = ctrl.signal.aborted;
      // If the run was paused mid-flight the handler may have thrown an
      // AbortError; treat that as a paused exit, not a failure.
      const cur = await prisma.backgroundRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (cur?.status === "paused" || cur?.status === "cancelled") {
        // Already terminal — leave it alone.
        log.info("Run exited via cancel/pause", { runId, status: cur.status });
      } else {
        const msg = aborted ? "ABORTED" : ((err as Error).message ?? String(err));
        await prisma.backgroundRun.update({
          where: { id: runId },
          data: {
            status: aborted ? "cancelled" : "failed",
            completedAt: new Date(),
            error: msg,
          },
        });
        this.emitter.status({
          id: runId,
          projectId: row.projectId,
          status: aborted ? "cancelled" : "failed",
          error: msg,
        });
      }
    } finally {
      this.controllers.delete(runId);
    }
  }
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

let singleton: AsyncRunner | null = null;
export function getAsyncRunner(): AsyncRunner {
  if (!singleton) singleton = new AsyncRunner();
  return singleton;
}
export function setAsyncRunnerForTests(r: AsyncRunner | null): void {
  singleton = r;
}
export function configureAsyncRunner(opts: AsyncRunnerOptions): AsyncRunner {
  singleton = new AsyncRunner(opts);
  return singleton;
}
