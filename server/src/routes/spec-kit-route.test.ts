/**
 * Spec Kit `/commands/:cmd` route — async enqueue contract (Epic #406 / #423).
 *
 * Complements `spec-kit-async.test.ts` (which unit-tests the worker) by
 * exercising the ROUTE: it mints a `jobId`, emits lifecycle, and returns the
 * full command result + the jobId (so the precise success payload — including
 * the grounded-completion line — and the error contract are preserved), while
 * the synchronous gates (Spec Kit enabled, command validity, RBAC) still reject
 * before any job is started. The command dispatch is mocked so the suite never
 * hits a provider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let currentUser: { userId: string; role: string } | null = { userId: "u1", role: "admin" };
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission: () => (_req: express.Request, _res: express.Response, next: () => void) =>
    next(),
}));

const { jobEvents } = vi.hoisted(() => ({
  jobEvents: {
    started: vi.fn(),
    progress: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    lifecycle: vi.fn(),
    docSection: vi.fn(),
  },
}));
vi.mock("../lib/socket/job-events.js", () => ({
  jobEvents,
  genericFailureMessage: (kind: string) => `GENERIC:${kind}`,
}));

const { enabledFlag } = vi.hoisted(() => ({ enabledFlag: { value: true } }));
vi.mock("../lib/spec-kit/artifacts.js", () => ({
  isSpecKitEnabled: vi.fn(async () => enabledFlag.value),
  SpecKitArtifactError: class extends Error {},
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
  writeArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  setSpecKitEnabled: vi.fn(),
}));

// The provider resolver must never be invoked synchronously (it is only built
// lazily inside the deferred dispatch).
vi.mock("../lib/ai/project-provider.js", () => ({
  resolveProjectProvider: vi.fn(async () => ({})),
}));

// Stub each command runner so dispatch resolves fast with a known message.
const grounded = "Generated spec.md (v1) in 900 tokens — grounded on 4 retrieved chunks.";
vi.mock("../lib/spec-kit/commands/specify.js", () => ({
  runSpecify: vi.fn(async () => ({ artifact: { version: 1 }, message: grounded, tokensUsed: 900 })),
}));

import { specKitRouter } from "./spec-kit.js";
import { AppError } from "../middleware/error-handler.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  // mergeParams router: mount under a project path so projectId is present.
  app.use("/projects/:projectId/spec-kit", specKitRouter());
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof AppError) {
        res
          .status(err.statusCode)
          .json({ success: false, error: { code: err.code, message: err.message } });
        return;
      }
      res.status(500).json({ success: false, error: { code: "INTERNAL", message: String(err) } });
    },
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { userId: "u1", role: "admin" };
  enabledFlag.value = true;
});

describe("POST /spec-kit/commands/:cmd — job + grounded-line preservation", () => {
  it("returns the result plus a jobId and emits started/completed (enqueue-returns-jobid)", async () => {
    const res = await request(makeApp())
      .post("/projects/p1/spec-kit/commands/specify")
      .send({ input: "build a billing dashboard" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.jobId).toBe("string");
    expect(res.body.data.jobId.length).toBeGreaterThan(0);
    expect(res.body.data.command).toBe("specify");
    // The grounded-completion line is preserved in the HTTP payload too.
    expect(res.body.data.message).toBe(grounded);
    // started fires for the job, and completed carries the grounded line verbatim.
    expect(jobEvents.started).toHaveBeenCalledWith(
      "spec-kit",
      res.body.data.jobId,
      "p1",
      expect.any(String),
    );
    expect(jobEvents.completed).toHaveBeenCalledWith(
      "spec-kit",
      res.body.data.jobId,
      "p1",
      grounded,
    );
  });

  it("runs the enabled gate synchronously — returns 409 when Spec Kit is disabled", async () => {
    enabledFlag.value = false;
    const res = await request(makeApp())
      .post("/projects/p1/spec-kit/commands/specify")
      .send({ input: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SPEC_KIT_DISABLED");
    // No job enqueued when the gate rejects.
    expect(jobEvents.started).not.toHaveBeenCalled();
  });

  it("rejects an unknown command with 400 (no enqueue)", async () => {
    const res = await request(makeApp())
      .post("/projects/p1/spec-kit/commands/not-a-command")
      .send({ input: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SPEC_KIT_UNKNOWN_COMMAND");
    expect(jobEvents.started).not.toHaveBeenCalled();
  });
});
