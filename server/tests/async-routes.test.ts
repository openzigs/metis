/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #156 — integration tests for the new async-platform routes.
 *
 * Mounts the routers on a thin express app with prisma + the AsyncRunner
 * mocked.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const tables = {
  bgRuns: new Map<string, any>(),
  runMessages: new Map<string, any>(),
  runGroups: new Map<string, any>(),
  triggers: new Map<string, any>(),
  projects: new Map<string, any>(),
  aISessions: new Map<string, any>(),
};
let seq = 0;

function reset(): void {
  for (const t of Object.values(tables)) t.clear();
  seq = 0;
  // pre-seed a project that route mocks can reference
  tables.projects.set("p1", {
    id: "p1",
    ownerId: "u1",
    deletedAt: null,
    contextCompactionThreshold: null,
  });
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    backgroundRun: {
      findMany: vi.fn(async ({ where, take }: any) => {
        const all = [...tables.bgRuns.values()].filter((r) => {
          if (where?.status && r.status !== where.status) return false;
          if (where?.projectId && r.projectId !== where.projectId) return false;
          return true;
        });
        all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return all.slice(0, take ?? 200);
      }),
      findUnique: vi.fn(async ({ where, include }: any) => {
        const r = tables.bgRuns.get(where.id);
        if (!r) return null;
        if (include?.messages) {
          const msgs = [...tables.runMessages.values()]
            .filter((m) => m.runId === r.id)
            .sort((a, b) => a.ord - b.ord);
          return { ...r, messages: msgs };
        }
        return r;
      }),
      // #1056 — the routes read runs through `findFirst` so the resolved
      // tenant scope (`projectId`) can be pinned in the `where` clause.
      findFirst: vi.fn(async ({ where, include }: any) => {
        const r = tables.bgRuns.get(where.id);
        if (!r) return null;
        if (where.projectId && r.projectId !== where.projectId) return null;
        if (include?.messages) {
          const msgs = [...tables.runMessages.values()]
            .filter((m) => m.runId === r.id)
            .sort((a, b) => a.ord - b.ord);
          return { ...r, messages: msgs };
        }
        return r;
      }),
      create: vi.fn(async ({ data }: any) => {
        seq++;
        const row = {
          id: `bg_${seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        tables.bgRuns.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = tables.bgRuns.get(where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
    },
    runMessage: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const all = [...tables.runMessages.values()].filter((m) => m.runId === where.runId);
        if (orderBy?.ord === "desc") all.sort((a, b) => b.ord - a.ord);
        return all[0] ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        seq++;
        const row = { id: `msg_${seq}`, status: "queued", createdAt: new Date(), ...data };
        tables.runMessages.set(row.id, row);
        return row;
      }),
    },
    runGroup: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        const r = tables.runGroups.get(where.id);
        if (!r) return null;
        if (include?.runs) {
          const runs = [...tables.bgRuns.values()].filter((b) => b.runGroupId === r.id);
          return { ...r, runs };
        }
        return r;
      }),
      // #1056 — see the `backgroundRun.findFirst` note above.
      findFirst: vi.fn(async ({ where, include }: any) => {
        const r = tables.runGroups.get(where.id);
        if (!r) return null;
        if (where.projectId && r.projectId !== where.projectId) return null;
        if (include?.runs) {
          const runs = [...tables.bgRuns.values()].filter((b) => b.runGroupId === r.id);
          return { ...r, runs };
        }
        return r;
      }),
    },
    trigger: {
      findMany: vi.fn(async ({ where }: any) => {
        return [...tables.triggers.values()].filter((t) => {
          if (where?.projectId && t.projectId !== where.projectId) return false;
          if (where?.source && t.source !== where.source) return false;
          if (where?.enabled !== undefined && t.enabled !== where.enabled) return false;
          return true;
        });
      }),
      findUnique: vi.fn(async ({ where }: any) => tables.triggers.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        seq++;
        const row = {
          id: `tg_${seq}`,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastFiredAt: null,
          ...data,
        };
        tables.triggers.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = tables.triggers.get(where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
      delete: vi.fn(async ({ where }: any) => {
        tables.triggers.delete(where.id);
        return { id: where.id };
      }),
    },
    project: {
      findUnique: vi.fn(async ({ where }: any) => {
        const r = tables.projects.get(where.id);
        return r && !r.deletedAt ? r : null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const r = tables.projects.get(where.id);
        return r && !r.deletedAt ? r : null;
      }),
    },
    aISession: {
      findUnique: vi.fn(async ({ where }: any) => tables.aISessions.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const r = tables.aISessions.get(where.id) ?? { id: where.id };
        Object.assign(r, data);
        tables.aISessions.set(r.id, r);
        return r;
      }),
    },
  },
}));

// Mock async runner — capture submissions for assertion
const submitMock = vi.fn(async ({ projectId, sessionId, kind, payload }: any) => {
  seq++;
  const row = {
    id: `bg_${seq}`,
    projectId,
    sessionId: sessionId ?? null,
    kind,
    status: "queued",
    priority: 0,
    runGroupId: null,
    payload,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  tables.bgRuns.set(row.id, row);
  return row;
});
const cancelMock = vi.fn(async (id: string) => {
  const r = tables.bgRuns.get(id);
  if (!r || ["cancelled", "failed", "succeeded"].includes(r.status)) return false;
  r.status = "cancelled";
  return true;
});
const pauseMock = vi.fn(async (id: string) => {
  const r = tables.bgRuns.get(id);
  if (!r || r.status !== "running") return false;
  r.status = "paused";
  return true;
});
const resumeMock = vi.fn(async (id: string) => {
  const r = tables.bgRuns.get(id);
  if (!r || r.status !== "paused") return false;
  r.status = "queued";
  return true;
});

vi.mock("../src/lib/async/runner.js", () => ({
  getAsyncRunner: () => ({
    submit: submitMock,
    cancel: cancelMock,
    pause: pauseMock,
    resume: resumeMock,
  }),
}));

vi.mock("../src/lib/async/best-of-n.js", () => ({
  submitGroup: vi.fn(async ({ projectId, n }: any) => {
    seq++;
    const groupId = `grp_${seq}`;
    tables.runGroups.set(groupId, {
      id: groupId,
      projectId,
      n,
      strategy: "best-of-n",
      selectionMethod: "highest-score",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { groupId, runIds: Array.from({ length: n }, (_, i) => `bg_g${i}`) };
  }),
}));

import express from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { errorHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { backgroundRunsRouter } from "../src/routes/background-runs.js";
import { projectTriggersRouter, triggersWebhookRouter } from "../src/routes/triggers.js";
import { __resetWebhookReceiverRateLimiter } from "../src/middleware/webhook-receiver-rate-limit.js";

let adminToken: string;

function makeApp() {
  const app = express();
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      },
    }),
  );
  app.use("/api/runs", backgroundRunsRouter());
  app.use("/api/projects/:projectId/triggers", projectTriggersRouter());
  app.use("/api/triggers", triggersWebhookRouter());
  app.use(errorHandler);
  return app;
}

beforeAll(() => {
  adminToken = issueTokens({
    userId: "u1",
    username: "admin",
    role: "admin",
    permissions: getPermissionsForRole("admin"),
  }).accessToken;
});

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});
afterEach(() => reset());

describe("background-runs routes (#146)", () => {
  it("requires auth on submit", async () => {
    const res = await request(makeApp()).post("/api/runs/background").send({});
    expect(res.status).toBe(401);
  });

  it("submits, lists, gets, cancels, and rejects bad payloads", async () => {
    const app = makeApp();

    // bad payload
    const bad = await request(app)
      .post("/api/runs/background")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ projectId: "p1" });
    expect(bad.status).toBe(400);

    // submit
    const create = await request(app)
      .post("/api/runs/background")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ projectId: "p1", kind: "chat", payload: { msg: "hi" } });
    expect(create.status).toBe(202);
    const runId = create.body.data.runId;
    expect(runId).toMatch(/^bg_/);

    // list
    const list = await request(app)
      .get("/api/runs/background?projectId=p1")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.items.length).toBe(1);

    // get
    const got = await request(app)
      .get(`/api/runs/background/${runId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(got.status).toBe(200);
    expect(got.body.data.id).toBe(runId);

    // get not found
    const miss = await request(app)
      .get(`/api/runs/background/missing`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(miss.status).toBe(404);

    // cancel
    const cancel = await request(app)
      .post(`/api/runs/background/${runId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(cancel.status).toBe(200);

    // double-cancel = 409
    const cancel2 = await request(app)
      .post(`/api/runs/background/${runId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(cancel2.status).toBe(409);
  });

  it("pauses a running run and resumes a paused run", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/runs/background")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ projectId: "p1", kind: "chat" });
    const runId = create.body.data.runId;
    // mark as running so pause succeeds
    tables.bgRuns.get(runId)!.status = "running";

    const pause = await request(app)
      .post(`/api/runs/background/${runId}/pause`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(pause.status).toBe(200);

    const resume = await request(app)
      .post(`/api/runs/background/${runId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(resume.status).toBe(200);

    // resume on non-paused = 409
    tables.bgRuns.get(runId)!.status = "running";
    const resume2 = await request(app)
      .post(`/api/runs/background/${runId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(resume2.status).toBe(409);
  });

  it("submits a run group and fetches it", async () => {
    const app = makeApp();
    const grp = await request(app)
      .post("/api/runs/group")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ projectId: "p1", kind: "chat", n: 3 });
    expect(grp.status).toBe(202);
    const { groupId } = grp.body.data;

    const got = await request(app)
      .get(`/api/runs/group/${groupId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(got.status).toBe(200);
    expect(got.body.data.id).toBe(groupId);

    const miss = await request(app)
      .get(`/api/runs/group/nope`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(miss.status).toBe(404);
  });

  it("queues steer messages with monotonic ords", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/runs/background")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ projectId: "p1", kind: "chat" });
    const runId = create.body.data.runId;
    tables.bgRuns.get(runId)!.status = "running";

    const a = await request(app)
      .post(`/api/runs/${runId}/steer`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ message: "first" });
    expect(a.status).toBe(202);
    expect(a.body.data.ord).toBe(0);

    const b = await request(app)
      .post(`/api/runs/${runId}/steer`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ message: "second" });
    expect(b.body.data.ord).toBe(1);

    // bad payload
    const bad = await request(app)
      .post(`/api/runs/${runId}/steer`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(bad.status).toBe(400);

    // missing run
    const miss = await request(app)
      .post(`/api/runs/missing/steer`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ message: "x" });
    expect(miss.status).toBe(404);

    // terminal run
    tables.bgRuns.get(runId)!.status = "succeeded";
    const term = await request(app)
      .post(`/api/runs/${runId}/steer`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ message: "nope" });
    expect(term.status).toBe(409);
  });
});

describe("triggers routes (#147)", () => {
  it("CRUD over project triggers", async () => {
    const app = makeApp();

    // require auth
    const noAuth = await request(app).get("/api/projects/p1/triggers");
    expect(noAuth.status).toBe(401);

    // empty list
    const empty = await request(app)
      .get("/api/projects/p1/triggers")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(empty.status).toBe(200);
    expect(empty.body.data.items).toEqual([]);

    // bad create
    const bad = await request(app)
      .post("/api/projects/p1/triggers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(bad.status).toBe(400);

    // create
    const create = await request(app)
      .post("/api/projects/p1/triggers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "GH",
        source: "github",
        config: { repo: "acme/app", event: "issues.opened", secret: "s1" },
      });
    expect(create.status).toBe(201);
    const triggerId = create.body.data.id;

    // patch
    const patch = await request(app)
      .patch(`/api/projects/p1/triggers/${triggerId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: false });
    expect(patch.status).toBe(200);

    // delete
    const del = await request(app)
      .delete(`/api/projects/p1/triggers/${triggerId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
  });

  it("fires a generic webhook with valid HMAC and rejects bad signatures", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/projects/p1/triggers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Generic",
        source: "webhook",
        config: { secret: "shh", kind: "chat" },
      });
    const triggerId = create.body.data.id;

    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ payload: { msg: "hi" } });
    const sig =
      "sha256=" + crypto.createHmac("sha256", "shh").update(`${ts}.${body}`).digest("hex");

    // bad signature
    const bad = await request(app)
      .post(`/api/triggers/${triggerId}/fire`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-metis-signature", "sha256=deadbeef")
      .set("x-metis-timestamp", ts)
      .send(body);
    expect([400, 401, 403]).toContain(bad.status);

    // good signature
    const fire = await request(app)
      .post(`/api/triggers/${triggerId}/fire`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-metis-signature", sig)
      .set("x-metis-timestamp", ts)
      .send(body);
    expect(fire.status).toBeLessThan(400);
    expect(submitMock).toHaveBeenCalled();

    // missing trigger
    const miss = await request(app)
      .post(`/api/triggers/missing/fire`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-metis-signature", sig)
      .set("x-metis-timestamp", ts)
      .send(body);
    expect(miss.status).toBe(404);
  });

  it("dispatches GitHub webhooks to repo+event-matched triggers", async () => {
    const app = makeApp();
    const secret = "gh-secret";
    await request(app)
      .post("/api/projects/p1/triggers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "GH issues",
        source: "github",
        config: { secret, repo: "acme/app", event: "issues", kind: "analysis" },
      });

    const body = JSON.stringify({
      repository: { full_name: "acme/app" },
      action: "opened",
    });
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

    // No-match path: different repo
    const noMatch = await request(app)
      .post(`/api/triggers/github`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-github-event", "issues")
      .set("x-hub-signature-256", sig)
      .send(JSON.stringify({ repository: { full_name: "other/repo" } }));
    expect(noMatch.status).toBe(200);
    expect(noMatch.body.data.matched).toBe(0);

    // No payload repo
    const badPayload = await request(app)
      .post(`/api/triggers/github`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-github-event", "issues")
      .set("x-hub-signature-256", sig)
      .send(JSON.stringify({}));
    expect(badPayload.status).toBe(400);

    // Match + verified
    const ok = await request(app)
      .post(`/api/triggers/github`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-github-event", "issues")
      .set("x-hub-signature-256", sig)
      .send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.data.fired.length).toBe(1);

    // Match + bad signature → not fired
    const badSig = await request(app)
      .post(`/api/triggers/github`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-github-event", "issues")
      .set("x-hub-signature-256", "sha256=00")
      .send(body);
    expect(badSig.status).toBe(200);
    expect(badSig.body.data.fired.length).toBe(0);
  });

  it("dispatches Slack webhooks to channel+command-matched triggers", async () => {
    const app = makeApp();
    const secret = "slack-secret";
    await request(app)
      .post("/api/projects/p1/triggers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "/run-analysis",
        source: "slack",
        config: { secret, channel: "C123", command: "/run", kind: "analysis" },
      });

    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ channel_id: "C123", command: "/run" });
    const base = `v0:${ts}:${body}`;
    const sig = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");

    const noMatch = await request(app)
      .post(`/api/triggers/slack`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-slack-signature", sig)
      .set("x-slack-request-timestamp", ts)
      .send(JSON.stringify({ channel_id: "OTHER", command: "/run" }));
    expect(noMatch.body.data.matched).toBe(0);

    const okRes = await request(app)
      .post(`/api/triggers/slack`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-slack-signature", sig)
      .set("x-slack-request-timestamp", ts)
      .send(body);
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.fired.length).toBe(1);

    // Slack with bad signature → matched but not fired
    const badSig = await request(app)
      .post(`/api/triggers/slack`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-slack-signature", "v0=00")
      .set("x-slack-request-timestamp", ts)
      .send(body);
    expect(badSig.body.data.fired.length).toBe(0);
  });

  it("rejects fire on non-webhook source and on disabled triggers", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/projects/p1/triggers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "GH-only",
        source: "github",
        config: { secret: "x", repo: "a/b" },
      });
    const triggerId = create.body.data.id;

    // /:id/fire on non-webhook source → 400
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({});
    const sig = "sha256=" + crypto.createHmac("sha256", "x").update(`${ts}.${body}`).digest("hex");
    const wrongSrc = await request(app)
      .post(`/api/triggers/${triggerId}/fire`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-metis-signature", sig)
      .set("x-metis-timestamp", ts)
      .send(body);
    expect(wrongSrc.status).toBe(400);

    // Disable trigger → /:id/fire returns 404
    await request(app)
      .patch(`/api/projects/p1/triggers/${triggerId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: false });
    const disabled = await request(app)
      .post(`/api/triggers/${triggerId}/fire`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-metis-signature", sig)
      .set("x-metis-timestamp", ts)
      .send(body);
    expect(disabled.status).toBe(404);
  });

  it("github webhook returns 200 with matched=0 when no triggers match", async () => {
    const app = makeApp();
    // No triggers configured at all
    const res = await request(app)
      .post(`/api/triggers/github`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-github-event", "push")
      .set("x-hub-signature-256", "sha256=deadbeef")
      .send(JSON.stringify({ repository: { full_name: "nobody/cares" } }));
    expect(res.status).toBe(200);
    expect(res.body.data.matched).toBe(0);
  });

  it("slack webhook returns 200 with matched=0 when no triggers match", async () => {
    const app = makeApp();
    const res = await request(app)
      .post(`/api/triggers/slack`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-slack-signature", "v0=deadbeef")
      .set("x-slack-request-timestamp", "1700000000")
      .send(JSON.stringify({ channel_id: "X" }));
    expect(res.status).toBe(200);
    expect(res.body.data.matched).toBe(0);
  });

  it("github webhook rejects a request missing the signature header before any DB scan (#680)", async () => {
    const app = makeApp();
    const res = await request(app)
      .post(`/api/triggers/github`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .set("x-github-event", "push")
      .send(JSON.stringify({ repository: { full_name: "nobody/cares" } }));
    expect(res.status).toBe(401);
  });

  it("slack webhook rejects a request missing signature headers before any DB scan (#680)", async () => {
    const app = makeApp();
    const res = await request(app)
      .post(`/api/triggers/slack`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ channel_id: "X" }));
    expect(res.status).toBe(401);
  });

  it("caps the trigger fan-out per delivery (#680)", async () => {
    const app = makeApp();
    const secret = "gh-secret";
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/projects/p1/triggers")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          name: `GH ${i}`,
          source: "github",
          config: { secret, repo: "acme/app", event: "issues", kind: "analysis" },
        });
    }
    const body = JSON.stringify({ repository: { full_name: "acme/app" }, action: "opened" });
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    process.env.MAX_TRIGGER_FANOUT = "2";
    try {
      const res = await request(app)
        .post(`/api/triggers/github`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Content-Type", "application/json")
        .set("x-github-event", "issues")
        .set("x-hub-signature-256", sig)
        .send(body);
      expect(res.status).toBe(200);
      expect(res.body.data.matched).toBe(3);
      expect(res.body.data.fired.length).toBe(2);
    } finally {
      delete process.env.MAX_TRIGGER_FANOUT;
    }
  });

  it("rate-limits the unauthenticated webhook receivers (#680)", async () => {
    process.env.WEBHOOK_RECEIVER_LIMIT_MAX = "2";
    __resetWebhookReceiverRateLimiter();
    try {
      const app = makeApp();
      const send = () =>
        request(app)
          .post(`/api/triggers/slack`)
          .set("Authorization", `Bearer ${adminToken}`)
          .set("Content-Type", "application/json")
          .set("x-slack-signature", "v0=deadbeef")
          .set("x-slack-request-timestamp", "1700000000")
          .send(JSON.stringify({ channel_id: "X" }));
      await send();
      await send();
      const third = await send();
      expect(third.status).toBe(429);
    } finally {
      delete process.env.WEBHOOK_RECEIVER_LIMIT_MAX;
      __resetWebhookReceiverRateLimiter();
    }
  });
});
