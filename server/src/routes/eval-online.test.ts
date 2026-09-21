/**
 * Issue #1321 — online eval read API tests.
 *
 * Same authz posture as the domain-eval read API: `requirePermission("admin.read")`
 * over internal platform telemetry with no tenant PK to scope on (#678).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OnlineEvalSample, OnlineEvalWindow } from "@metis/shared";

interface TestUser {
  userId: string;
  role: string;
}
let currentUser: TestUser = { userId: "user-1", role: "admin" };
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: TestUser }).user = currentUser;
    next();
  },
}));

const { onlineEvalRouter } = await import("./eval-online.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { writeWindow } = await import("../lib/eval/online/store.js");
const { OnlineEvalScorer } = await import("../lib/eval/online/scorer.js");

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "online-route-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length) await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeSample(id: string): OnlineEvalSample {
  return {
    sampleId: id,
    surface: "chat",
    observedAt: "2026-08-15T00:00:00.000Z",
    questionHash: "a".repeat(64),
    answerHash: "b".repeat(64),
    questionChars: 10,
    answerChars: 20,
    contextCount: 1,
    contextChars: 30,
    redactionHits: 0,
    scores: {
      context_precision: 1,
      context_recall: 1,
      faithfulness: 0.9,
      answer_relevancy: 0.8,
    },
    tokensCharged: 200,
  };
}

function makeWindow(windowId: string, completedAt: string, faithfulness = 0.9): OnlineEvalWindow {
  return {
    windowId,
    schemaVersion: 1,
    startedAt: completedAt,
    completedAt,
    judge: "StubRagasJudge",
    judgeMeaningful: false,
    sampleCount: 1,
    meanScores: {
      context_precision: 1,
      context_recall: 1,
      faithfulness,
      answer_relevancy: 0.8,
    },
    scored: { context_precision: 1, context_recall: 1, faithfulness: 1, answer_relevancy: 1 },
    unverifiable: {
      context_precision: 0,
      context_recall: 0,
      faithfulness: 0,
      answer_relevancy: 0,
    },
    trendedMetrics: ["faithfulness", "answer_relevancy"],
    drift: {
      metric: "faithfulness",
      previous: null,
      delta: null,
      thresholdPct: 0.05,
      alert: false,
      reason: "NO_PREVIOUS_WINDOW",
    },
    budget: { monthBucket: "2026-08", tokensUsed: 200, tokensCap: 250_000, calls: 1 },
    samples: [makeSample("s-1")],
  };
}

function createApp(resultsDir: string) {
  const app = express();
  app.use(express.json());
  const scorer = new OnlineEvalScorer({
    config: () => ({
      enabled: false,
      sampleRate: 0.01,
      monthlyTokenBudget: 250_000,
      tokensPerScore: 1500,
      windowSize: 20,
      driftThresholdPct: 0.05,
      driftAlertsEnabled: false,
      maxChars: 4000,
      resultsDir,
    }),
  });
  app.use("/eval/online", onlineEvalRouter({ resultsDir, scorer }));
  app.use(errorHandler);
  return app;
}

describe("onlineEvalRouter", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    currentUser = { userId: "user-1", role: "admin" };
    dir = await tmp();
    app = createApp(dir);
  });

  describe("GET /eval/online/windows", () => {
    it("returns summaries newest-first without the per-sample payload", async () => {
      await writeWindow(dir, makeWindow("online-old", "2026-01-01T00:00:00.000Z", 0.8));
      await writeWindow(dir, makeWindow("online-new", "2026-02-01T00:00:00.000Z", 0.95));
      const res = await request(app).get("/eval/online/windows?days=365");
      expect(res.status).toBe(200);
      expect(res.body.data.windows.map((w: { windowId: string }) => w.windowId)).toEqual([
        "online-new",
        "online-old",
      ]);
      expect(res.body.data.windows[0]).toHaveProperty("driftAlert");
      expect(res.body.data.windows[0]).not.toHaveProperty("samples");
    });

    it("filters by the days window", async () => {
      await writeWindow(dir, makeWindow("online-recent", new Date().toISOString()));
      await writeWindow(dir, makeWindow("online-ancient", "2000-01-01T00:00:00.000Z"));
      const res = await request(app).get("/eval/online/windows?days=30");
      const ids = res.body.data.windows.map((w: { windowId: string }) => w.windowId);
      expect(ids).toEqual(["online-recent"]);
    });

    it("returns an empty list when nothing has been scored", async () => {
      const res = await request(app).get("/eval/online/windows");
      expect(res.status).toBe(200);
      expect(res.body.data.windows).toEqual([]);
    });

    it("rejects an invalid days query", async () => {
      const res = await request(app).get("/eval/online/windows?days=0");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /eval/online/windows/:id", () => {
    it("returns the full window including the content-free sample rows", async () => {
      await writeWindow(dir, makeWindow("online-detail", "2026-02-01T00:00:00.000Z"));
      const res = await request(app).get("/eval/online/windows/online-detail");
      expect(res.status).toBe(200);
      expect(res.body.data.window.samples).toHaveLength(1);
      expect(res.body.data.window.samples[0].questionHash).toMatch(/^[a-f0-9]{64}$/);
      expect(res.body.data.window.samples[0]).not.toHaveProperty("question");
    });

    it("404s for an unknown window", async () => {
      const res = await request(app).get("/eval/online/windows/missing");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ONLINE_EVAL_WINDOW_NOT_FOUND");
    });

    it("404s for a path-traversal id rather than reading outside the dir", async () => {
      const res = await request(app).get("/eval/online/windows/..%2f..%2fsecret");
      expect(res.status).toBe(404);
    });

    it("404s rather than serving the budget ledger as a window", async () => {
      await fs.writeFile(path.join(dir, "budget.json"), "{}", "utf8");
      const res = await request(app).get("/eval/online/windows/budget");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /eval/online/status", () => {
    it("reports the operator status including the judge honesty marker", async () => {
      const res = await request(app).get("/eval/online/status");
      expect(res.status).toBe(200);
      expect(res.body.data.status).toMatchObject({
        enabled: false,
        sampleRate: 0.01,
        driftAlertsEnabled: false,
        judge: "StubRagasJudge",
        judgeMeaningful: false,
        pendingSamples: 0,
      });
    });
  });

  describe("the read path points at the directory the scorer writes to", () => {
    // The dominant defect shape for a new endpoint is a write that succeeds
    // while the read cannot see it. Both sides here default to the SAME
    // resolved config, so pin that rather than only testing the injected seam.
    it("defaults to the scorer's configured results directory", async () => {
      const { resolveOnlineEvalConfig, defaultOnlineResultsDir } =
        await import("../lib/eval/online/config.js");
      expect(resolveOnlineEvalConfig().resultsDir).toBe(defaultOnlineResultsDir());
    });

    it("serves a window written by the scorer's own store, end to end", async () => {
      const { OnlineEvalScorer: Scorer } = await import("../lib/eval/online/scorer.js");
      const scorer = new Scorer({
        config: () => ({
          enabled: true,
          sampleRate: 1,
          monthlyTokenBudget: 100_000,
          tokensPerScore: 100,
          windowSize: 1,
          driftThresholdPct: 0.05,
          driftAlertsEnabled: false,
          maxChars: 500,
          resultsDir: dir,
        }),
        random: () => 0,
        defer: (fn) => fn(),
      });
      const out = await scorer.score({
        surface: "chat",
        question: "what is the refund window?",
        answer: "thirty days",
        contexts: ["policy: thirty days"],
      });
      expect(out.scored).toBe(true);

      const res = await request(app).get("/eval/online/windows?days=365");
      expect(res.status).toBe(200);
      expect(res.body.data.windows.map((w: { windowId: string }) => w.windowId)).toEqual([
        out.window?.windowId,
      ]);
    });
  });

  describe("authorization", () => {
    it("denies a caller without admin.read on every route", async () => {
      currentUser = { userId: "user-2", role: "viewer" };
      for (const url of [
        "/eval/online/status",
        "/eval/online/windows",
        "/eval/online/windows/anything",
      ]) {
        const res = await request(app).get(url);
        expect(res.status).toBe(403);
      }
    });
  });
});
