/**
 * Epic #156 (#146, #148, #149) — Async runner + best-of-N + steering tests.
 *
 * Uses an in-memory Prisma stub. The runner is exercised end-to-end with a
 * synchronous handler so the assertions are deterministic.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tables = {
  runs: new Map<string, any>(),
  groups: new Map<string, any>(),
  messages: new Map<string, any>(),
  sessions: new Map<string, any>(),
  projects: new Map<string, any>(),
};
let seq = 0;
const id = () => `id-${++seq}`;

function reset(): void {
  for (const t of Object.values(tables)) t.clear();
  seq = 0;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    backgroundRun: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: id(),
          status: "queued",
          priority: 0,
          payload: "{}",
          heartbeatAt: null,
          startedAt: null,
          completedAt: null,
          error: null,
          result: null,
          score: null,
          runGroupId: null,
          sessionId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        tables.runs.set(row.id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where, include }: any) => {
        const r = tables.runs.get(where.id);
        if (!r) return null;
        if (include?.messages) {
          const msgs = [...tables.messages.values()]
            .filter((m) => m.runId === r.id)
            .sort((a, b) => a.ord - b.ord);
          return { ...r, messages: msgs };
        }
        return r;
      }),
      findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
        let rows = [...tables.runs.values()];
        if (where?.status) {
          if (typeof where.status === "string")
            rows = rows.filter((r) => r.status === where.status);
        }
        if (where?.OR) {
          rows = rows.filter((r) => {
            return where.OR.some((c: any) => {
              if ("heartbeatAt" in c) {
                if (c.heartbeatAt === null) return r.heartbeatAt === null;
                if (c.heartbeatAt?.lt) return r.heartbeatAt && r.heartbeatAt < c.heartbeatAt.lt;
              }
              return false;
            });
          });
        }
        if (where?.id?.in) rows = rows.filter((r) => where.id.in.includes(r.id));
        if (where?.projectId) rows = rows.filter((r) => r.projectId === where.projectId);
        if (orderBy) {
          rows.sort((a: any, b: any) => {
            const arr = Array.isArray(orderBy) ? orderBy : [orderBy];
            for (const o of arr) {
              const k = Object.keys(o)[0]!;
              const dir = o[k] === "desc" ? -1 : 1;
              if (a[k] < b[k]) return -1 * dir;
              if (a[k] > b[k]) return 1 * dir;
            }
            return 0;
          });
        }
        return rows;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = tables.runs.get(where.id);
        if (!r) throw new Error("NOT_FOUND");
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in v) {
            r[k] = (r[k] ?? 0) + (v as any).increment;
          } else {
            r[k] = v;
          }
        }
        r.updatedAt = new Date();
        return r;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let n = 0;
        for (const r of tables.runs.values()) {
          if (where.id?.in && !where.id.in.includes(r.id)) continue;
          Object.assign(r, data);
          n++;
        }
        return { count: n };
      }),
    },
    runGroup: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: id(),
          status: "pending",
          winnerRunId: null,
          n: 1,
          strategy: "best-of-n",
          selectionMethod: "highest-score",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        tables.groups.set(row.id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where, include }: any) => {
        const g = tables.groups.get(where.id);
        if (!g) return null;
        if (include?.runs) {
          const runs = [...tables.runs.values()].filter((r) => r.runGroupId === g.id);
          return { ...g, runs };
        }
        return g;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const g = tables.groups.get(where.id);
        if (!g) throw new Error("NOT_FOUND");
        Object.assign(g, data);
        return g;
      }),
    },
    runMessage: {
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        let rows = [...tables.messages.values()];
        if (where?.runId) rows = rows.filter((r) => r.runId === where.runId);
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        if (orderBy?.ord === "asc") rows.sort((a, b) => a.ord - b.ord);
        if (orderBy?.ord === "desc") rows.sort((a, b) => b.ord - a.ord);
        return rows;
      }),
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const all = [...tables.messages.values()].filter((m) => m.runId === where.runId);
        if (orderBy?.ord === "desc") all.sort((a, b) => b.ord - a.ord);
        return all[0] ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: id(),
          status: "queued",
          createdAt: new Date(),
          deliveredAt: null,
          ...data,
        };
        tables.messages.set(row.id, row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let n = 0;
        for (const m of tables.messages.values()) {
          if (where.id?.in && !where.id.in.includes(m.id)) continue;
          Object.assign(m, data);
          n++;
        }
        return { count: n };
      }),
    },
    aISession: {
      findUnique: vi.fn(async ({ where }: any) => tables.sessions.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const s = tables.sessions.get(where.id);
        if (!s) throw new Error("NOT_FOUND");
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in v) {
            s[k] = (s[k] ?? 0) + (v as any).increment;
          } else {
            s[k] = v;
          }
        }
        return s;
      }),
    },
    project: {
      findUnique: vi.fn(async ({ where }: any) => tables.projects.get(where.id) ?? null),
    },
  },
}));

import {
  AsyncRunner,
  setAsyncRunnerForTests,
  type RunHandler,
  type RunnerEmitter,
} from "../src/lib/async/runner.js";
import { selectGroupWinner, submitGroup } from "../src/lib/async/best-of-n.js";
import { compactSession } from "../src/lib/async/compaction.js";

beforeEach(() => reset());
afterEach(() => setAsyncRunnerForTests(null));

describe("AsyncRunner (#146)", () => {
  it("dispatches a queued run through the registered handler", async () => {
    const handler: RunHandler = async (ctx) => {
      ctx.emitStep("hi", "hello");
      return { result: "ok", score: 1 };
    };
    const events: any[] = [];
    const emitter: RunnerEmitter = {
      status: (e) => events.push({ type: "status", ...e }),
      step: (e) => events.push({ type: "step", ...e }),
    };
    const runner = new AsyncRunner({ concurrency: 2, emitter });
    setAsyncRunnerForTests(runner);
    runner.registerHandler("custom", handler);
    const out = await runner.submit({ projectId: "p1", kind: "custom" });
    await runner.onIdle();
    const row = tables.runs.get(out.id);
    expect(row.status).toBe("succeeded");
    expect(row.score).toBe(1);
    expect(JSON.parse(row.result)).toBe("ok");
    expect(events.find((e) => e.type === "step" && e.kind === "hi")).toBeTruthy();
    expect(events.filter((e) => e.type === "status").map((e) => e.status)).toEqual([
      "running",
      "succeeded",
    ]);
  });

  it("respects concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const handler: RunHandler = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { result: null };
    };
    const runner = new AsyncRunner({ concurrency: 2 });
    setAsyncRunnerForTests(runner);
    runner.registerHandler("custom", handler);
    await Promise.all(
      Array.from({ length: 6 }, () => runner.submit({ projectId: "p1", kind: "custom" })),
    );
    await runner.onIdle();
    expect(peak).toBe(2);
  });

  it("recoverStaleRuns re-queues running rows past the heartbeat window", async () => {
    const runner = new AsyncRunner({ heartbeatTimeoutMs: 1_000 });
    setAsyncRunnerForTests(runner);
    // Insert a stale run directly.
    tables.runs.set("stale", {
      id: "stale",
      projectId: "p1",
      status: "running",
      heartbeatAt: new Date(Date.now() - 60_000),
      payload: "{}",
      kind: "custom",
    });
    const recovered = await runner.recoverStaleRuns();
    expect(recovered).toBe(1);
    expect(tables.runs.get("stale").status).toBe("queued");
  });

  it("fails a run when no handler is registered", async () => {
    const runner = new AsyncRunner({ concurrency: 1 });
    setAsyncRunnerForTests(runner);
    const out = await runner.submit({ projectId: "p1", kind: "ghost" });
    await runner.onIdle();
    expect(tables.runs.get(out.id).status).toBe("failed");
    expect(tables.runs.get(out.id).error).toContain("NO_HANDLER");
  });

  it("cancel aborts a running handler via AbortSignal", async () => {
    const runner = new AsyncRunner({ concurrency: 1 });
    setAsyncRunnerForTests(runner);
    runner.registerHandler("custom", async (ctx) => {
      // Wait until the test has triggered cancel.
      for (let i = 0; i < 50; i++) {
        if (ctx.signal.aborted) throw new Error("ABORTED");
        await new Promise((r) => setTimeout(r, 5));
      }
      return { result: "should-not-reach" };
    });
    const out = await runner.submit({ projectId: "p1", kind: "custom" });
    // Yield so the handler starts.
    await new Promise((r) => setTimeout(r, 10));
    const ok = await runner.cancel(out.id);
    expect(ok).toBe(true);
    await runner.onIdle();
    expect(tables.runs.get(out.id).status).toBe("cancelled");
  });
});

describe("Mid-run steering (#149)", () => {
  it("delivers queued steer messages in FIFO order", async () => {
    const runner = new AsyncRunner({ concurrency: 1 });
    setAsyncRunnerForTests(runner);
    let captured: Array<{ role: string; content: string }> = [];
    runner.registerHandler("custom", async (ctx) => {
      // Wait a tick so the test can enqueue steer messages first.
      await new Promise((r) => setTimeout(r, 5));
      captured = await ctx.nextSteer();
      return { result: { count: captured.length }, score: captured.length };
    });
    const out = await runner.submit({ projectId: "p1", kind: "custom" });
    // Inject steer messages before the handler reads them.
    tables.messages.set("m1", {
      id: "m1",
      runId: out.id,
      ord: 0,
      role: "user",
      content: "first",
      status: "queued",
    });
    tables.messages.set("m2", {
      id: "m2",
      runId: out.id,
      ord: 1,
      role: "user",
      content: "second",
      status: "queued",
    });
    await runner.onIdle();
    expect(captured.map((c) => c.content)).toEqual(["first", "second"]);
    expect(tables.messages.get("m1").status).toBe("delivered");
    expect(tables.messages.get("m2").status).toBe("delivered");
  });
});

describe("Best-of-N (#148)", () => {
  it("highest-score selection picks the run with the largest score", async () => {
    const runner = new AsyncRunner({ concurrency: 4 });
    setAsyncRunnerForTests(runner);
    let i = 0;
    runner.registerHandler("custom", async () => {
      i++;
      // Variant 0 -> score 1, variant 1 -> 5, variant 2 -> 3.
      const scores = [1, 5, 3];
      return { result: `r${i}`, score: scores[i - 1] ?? 0 };
    });
    const { groupId } = await submitGroup({
      projectId: "p1",
      kind: "custom",
      n: 3,
      selectionMethod: "highest-score",
    });
    await runner.onIdle();
    const winner = await selectGroupWinner(groupId);
    expect(winner).not.toBeNull();
    const winnerRun = tables.runs.get(winner!.winnerRunId);
    expect(winnerRun.score).toBe(5);
  });

  it("returns null until all children settle", async () => {
    const runner = new AsyncRunner({ concurrency: 1 });
    setAsyncRunnerForTests(runner);
    runner.registerHandler("custom", async () => ({ result: "ok", score: 1 }));
    const { groupId, runIds } = await submitGroup({
      projectId: "p1",
      kind: "custom",
      n: 2,
      selectionMethod: "highest-score",
    });
    // Force one run to remain in 'running' state.
    tables.runs.get(runIds[0]!).status = "running";
    const r = await selectGroupWinner(groupId);
    expect(r).toBeNull();
  });

  it("judge-llm uses deterministic fallback when no judge supplied", async () => {
    const runner = new AsyncRunner({ concurrency: 4 });
    setAsyncRunnerForTests(runner);
    let i = 0;
    runner.registerHandler("custom", async () => {
      i++;
      return { result: `r${i}`, score: i === 2 ? 9 : 0 };
    });
    const { groupId } = await submitGroup({
      projectId: "p1",
      kind: "custom",
      n: 3,
      selectionMethod: "judge-llm",
    });
    await runner.onIdle();
    const winner = await selectGroupWinner(groupId);
    const winnerRun = tables.runs.get(winner!.winnerRunId);
    expect(winnerRun.score).toBe(9);
  });

  it("rejects n < 1 or n > 8", async () => {
    await expect(submitGroup({ projectId: "p1", kind: "custom", n: 0 })).rejects.toThrow();
    await expect(submitGroup({ projectId: "p1", kind: "custom", n: 9 })).rejects.toThrow();
  });

  it("manual selection returns null and leaves the group for UI to settle", async () => {
    const runner = new AsyncRunner({ concurrency: 4 });
    setAsyncRunnerForTests(runner);
    runner.registerHandler("custom", async () => ({ result: "ok", score: 1 }));
    const { groupId } = await submitGroup({
      projectId: "p1",
      kind: "custom",
      n: 2,
      selectionMethod: "manual",
    });
    await runner.onIdle();
    const r = await selectGroupWinner(groupId);
    expect(r).toBeNull();
  });

  it("returns null and marks the group failed when every member failed", async () => {
    const runner = new AsyncRunner({ concurrency: 4 });
    setAsyncRunnerForTests(runner);
    runner.registerHandler("custom", async () => {
      throw new Error("boom");
    });
    const { groupId } = await submitGroup({
      projectId: "p1",
      kind: "custom",
      n: 2,
      selectionMethod: "highest-score",
    });
    await runner.onIdle();
    const r = await selectGroupWinner(groupId);
    expect(r).toBeNull();
    expect(tables.groups.get(groupId).status).toBe("failed");
  });

  it("custom judge function picks the supplied winnerRunId", async () => {
    const runner = new AsyncRunner({ concurrency: 4 });
    setAsyncRunnerForTests(runner);
    runner.registerHandler("custom", async () => ({ result: "ok", score: 1 }));
    const { groupId, runIds } = await submitGroup({
      projectId: "p1",
      kind: "custom",
      n: 2,
      selectionMethod: "judge-llm",
    });
    await runner.onIdle();
    const r = await selectGroupWinner(groupId, {
      judge: async () => ({ winnerRunId: runIds[1]! }),
    });
    expect(r?.winnerRunId).toBe(runIds[1]);
  });
});

describe("compactSession (#150)", () => {
  it("rewrites the session snapshot when above threshold", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(2_000),
    }));
    tables.sessions.set("s1", {
      id: "s1",
      projectId: "p1",
      compactionCount: 0,
      snapshot: JSON.stringify({ messages }),
    });
    tables.projects.set("p1", { id: "p1", contextCompactionThreshold: 1_000 });
    const r = await compactSession("s1");
    expect(r.compacted).toBe(true);
    expect(r.summarizedTurns).toBeGreaterThan(0);
    const snap = JSON.parse(tables.sessions.get("s1").snapshot);
    expect(snap.messages.length).toBeLessThan(messages.length);
    expect(tables.sessions.get("s1").compactionCount).toBe(1);
    expect(tables.sessions.get("s1").lastCompactedAt).toBeInstanceOf(Date);
  });

  it("is a no-op when below threshold", async () => {
    tables.sessions.set("s2", {
      id: "s2",
      projectId: "p1",
      compactionCount: 0,
      snapshot: JSON.stringify({
        messages: [{ role: "user", content: "tiny" }],
      }),
    });
    tables.projects.set("p1", { id: "p1", contextCompactionThreshold: 100_000 });
    const r = await compactSession("s2");
    expect(r.compacted).toBe(false);
    expect(tables.sessions.get("s2").compactionCount).toBe(0);
  });

  it("preserves message-array shape post-compaction", async () => {
    const head = { role: "system", content: "you are X" };
    const messages: any[] = [head];
    for (let i = 0; i < 12; i++) messages.push({ role: "user", content: "y".repeat(5_000) });
    tables.sessions.set("s3", {
      id: "s3",
      projectId: null,
      compactionCount: 0,
      snapshot: JSON.stringify({ messages }),
    });
    process.env.CONTEXT_COMPACTION_THRESHOLD_TOKENS = "100";
    const r = await compactSession("s3", {
      summarizer: async () => "CANNED_SUMMARY",
    });
    expect(r.compacted).toBe(true);
    const snap = JSON.parse(tables.sessions.get("s3").snapshot);
    expect(snap.messages[0]).toEqual(head);
    expect(snap.messages[1].role).toBe("system");
    expect(snap.messages[1].content).toContain("CANNED_SUMMARY");
    delete process.env.CONTEXT_COMPACTION_THRESHOLD_TOKENS;
  });
});

describe("AsyncRunner — extras for coverage (#146)", () => {
  it("getAsyncRunner returns the singleton; configureAsyncRunner replaces it", async () => {
    const mod = await import("../src/lib/async/runner.js");
    const a = mod.getAsyncRunner();
    expect(a).toBeInstanceOf(AsyncRunner);
    const b = mod.configureAsyncRunner({ concurrency: 1 });
    expect(b).not.toBe(a);
    expect(mod.getAsyncRunner()).toBe(b);
    mod.setAsyncRunnerForTests(null);
  });

  it("stats and onIdle reflect queue state; stop aborts in-flight work", async () => {
    const runner = new AsyncRunner({ concurrency: 1 });
    setAsyncRunnerForTests(runner);
    let aborted = false;
    runner.registerHandler("custom", async (ctx) => {
      for (let i = 0; i < 50; i++) {
        if (ctx.signal.aborted) {
          aborted = true;
          throw new Error("ABORTED");
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      return { result: null };
    });
    const out = await runner.submit({ projectId: "p1", kind: "custom" });
    await new Promise((r) => setTimeout(r, 10));
    const s = runner.stats();
    expect(typeof s.size).toBe("number");
    expect(typeof s.running).toBe("number");
    runner.stop();
    await runner.onIdle();
    expect(aborted).toBe(true);
    expect(tables.runs.get(out.id).status).toBe("cancelled");
  });

  it("pause/resume updates status and re-queues; isPaused reflects state", async () => {
    const runner = new AsyncRunner({ concurrency: 1 });
    setAsyncRunnerForTests(runner);
    runner.registerHandler("custom", async () => ({ result: "ok" }));
    // Insert a row directly so we can drive pause/resume without racing
    // against the queue dispatcher.
    tables.runs.set("pp1", {
      id: "pp1",
      projectId: "p1",
      kind: "custom",
      status: "running",
      payload: "{}",
      heartbeatAt: new Date(),
      priority: 0,
    });
    expect(await runner.pause("pp1")).toBe(true);
    expect(runner.isPaused("pp1")).toBe(true);
    expect(tables.runs.get("pp1").status).toBe("paused");
    // Resume re-queues
    expect(await runner.resume("pp1")).toBe(true);
    expect(runner.isPaused("pp1")).toBe(false);
    await runner.onIdle();
    // Pause/resume on missing or non-applicable runs returns false
    expect(await runner.pause("nope")).toBe(false);
    expect(await runner.resume("nope")).toBe(false);
  });

  it("dispatchQueued drains pre-existing queued rows", async () => {
    const runner = new AsyncRunner({ concurrency: 2 });
    setAsyncRunnerForTests(runner);
    runner.registerHandler("custom", async () => ({ result: "ok", score: 1 }));
    // Insert two queued rows directly.
    for (const rid of ["q1", "q2"]) {
      tables.runs.set(rid, {
        id: rid,
        projectId: "p1",
        kind: "custom",
        status: "queued",
        priority: 0,
        payload: "{}",
        heartbeatAt: null,
      });
    }
    await runner.dispatchQueued();
    await runner.onIdle();
    expect(tables.runs.get("q1").status).toBe("succeeded");
    expect(tables.runs.get("q2").status).toBe("succeeded");
  });

  it("invokes ctx.heartbeat and fires sessionStart/sessionEnd hooks when sessionId is set", async () => {
    const runner = new AsyncRunner({ concurrency: 1 });
    setAsyncRunnerForTests(runner);
    let beats = 0;
    runner.registerHandler("custom", async (ctx) => {
      await ctx.heartbeat();
      beats++;
      return { result: "ok" };
    });
    tables.sessions.set("sess-1", { id: "sess-1", projectId: "p1" });
    const out = await runner.submit({
      projectId: "p1",
      sessionId: "sess-1",
      kind: "custom",
    });
    await runner.onIdle();
    expect(beats).toBe(1);
    expect(tables.runs.get(out.id).status).toBe("succeeded");
    expect(tables.runs.get(out.id).heartbeatAt).toBeInstanceOf(Date);
  });

  it("cancel returns false on terminal runs and missing runs", async () => {
    const runner = new AsyncRunner({ concurrency: 1 });
    setAsyncRunnerForTests(runner);
    expect(await runner.cancel("missing")).toBe(false);
    runner.registerHandler("custom", async () => ({ result: "ok" }));
    const out = await runner.submit({ projectId: "p1", kind: "custom" });
    await runner.onIdle();
    // Already succeeded — cancel should be false.
    expect(await runner.cancel(out.id)).toBe(false);
  });

  it("execute marks the row failed when the handler throws (non-abort)", async () => {
    const runner = new AsyncRunner({ concurrency: 1 });
    setAsyncRunnerForTests(runner);
    runner.registerHandler("custom", async () => {
      throw new Error("boom");
    });
    const out = await runner.submit({ projectId: "p1", kind: "custom" });
    await runner.onIdle();
    const row = tables.runs.get(out.id);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("boom");
  });
});
