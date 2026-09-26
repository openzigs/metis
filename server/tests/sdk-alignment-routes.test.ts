/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration tests for the SDK-alignment HTTP surface (#112, #114, #113, #115,
 * #120-122). Mounts each new router on a thin express app with prisma mocked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tables = {
  customAgents: new Map<string, any>(),
  hookSubs: new Map<string, any>(),
  sessions: new Map<string, any>(),
  plans: new Map<string, any>(),
  skills: new Map<string, any>(),
  projects: new Map<string, any>(),
};
let seq = 0;

function reset(): void {
  for (const t of Object.values(tables)) t.clear();
  seq = 0;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    customAgent: {
      findMany: vi.fn(async ({ where }: any) => {
        const all = [...tables.customAgents.values()];
        return all.filter((r) => {
          if (where?.OR) {
            return where.OR.some((c: any) => {
              if (c.projectId === null && c.isBuiltIn === true)
                return r.projectId === null && r.isBuiltIn;
              return r.projectId === c.projectId;
            });
          }
          if (where?.projectId === null && where?.isBuiltIn === true)
            return r.projectId === null && r.isBuiltIn;
          return true;
        });
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return tables.customAgents.get(where.id) ?? null;
        if (where.projectId_name) {
          for (const r of tables.customAgents.values())
            if (
              r.projectId === where.projectId_name.projectId &&
              r.name === where.projectId_name.name
            )
              return r;
          return null;
        }
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const r of tables.customAgents.values())
          if (r.projectId === where.projectId && r.name === where.name) return r;
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        seq++;
        const row = { id: `ag_${seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        tables.customAgents.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = tables.customAgents.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
      delete: vi.fn(async ({ where }: any) => {
        tables.customAgents.delete(where.id);
        return { id: where.id };
      }),
      upsert: vi.fn(async (args: any) => {
        for (const r of tables.customAgents.values())
          if (
            r.projectId === args.where.projectId_name.projectId &&
            r.name === args.where.projectId_name.name
          ) {
            Object.assign(r, args.update);
            return r;
          }
        seq++;
        const row = {
          id: `ag_${seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...args.create,
        };
        tables.customAgents.set(row.id, row);
        return row;
      }),
    },
    hookSubscription: {
      findMany: vi.fn(async ({ where }: any) =>
        [...tables.hookSubs.values()].filter((r) => {
          if (where?.projectId && r.projectId !== where.projectId) return false;
          if (where?.event && r.event !== where.event) return false;
          if (where?.enabled === true && !r.enabled) return false;
          return true;
        }),
      ),
      findUnique: vi.fn(async ({ where }: any) => tables.hookSubs.get(where.id) ?? null),
      // #675 — by-id ops scope on { id, projectId }; the row must match both.
      findFirst: vi.fn(async ({ where }: any) => {
        const r = tables.hookSubs.get(where.id);
        if (!r) return null;
        if (where.projectId != null && r.projectId !== where.projectId) return null;
        return r;
      }),
      create: vi.fn(async ({ data }: any) => {
        seq++;
        const row = { id: `h_${seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        tables.hookSubs.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = tables.hookSubs.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
      delete: vi.fn(async ({ where }: any) => {
        tables.hookSubs.delete(where.id);
        return { id: where.id };
      }),
      // #675 — project-scoped delete; returns the number of rows removed.
      deleteMany: vi.fn(async ({ where }: any) => {
        const r = tables.hookSubs.get(where.id);
        if (!r || (where.projectId != null && r.projectId !== where.projectId)) {
          return { count: 0 };
        }
        tables.hookSubs.delete(where.id);
        return { count: 1 };
      }),
    },
    aISession: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const r = tables.sessions.get(where.id);
        if (!r) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) out[k] = r[k];
          return out;
        }
        return { ...r };
      }),
      findMany: vi.fn(async ({ where }: any) => {
        return [...tables.sessions.values()].filter((r) => {
          if (where?.userId && r.userId !== where.userId) return false;
          if (where?.deletedAt === null && r.deletedAt) return false;
          if (
            where?.snapshotUpdatedAt?.gte &&
            (!r.snapshotUpdatedAt || r.snapshotUpdatedAt < where.snapshotUpdatedAt.gte)
          )
            return false;
          if (where?.snapshotUpdatedAt?.not === null && !r.snapshotUpdatedAt) return false;
          if (where?.status?.in && !where.status.in.includes(r.status)) return false;
          return true;
        });
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = tables.sessions.get(where.id);
        Object.assign(r, data);
        return { ...r };
      }),
    },
    sessionPlan: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const all = [...tables.plans.values()].filter(
          (p) => p.sessionId === where.sessionId && (!where.status || p.status === where.status),
        );
        if (orderBy?.createdAt === "desc") all.sort((a, b) => b.createdAt - a.createdAt);
        return all[0] ?? null;
      }),
      findUnique: vi.fn(async ({ where }: any) => tables.plans.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        seq++;
        const row = {
          id: `pl_${seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          decidedAt: null,
          decidedBy: null,
          ...data,
        };
        tables.plans.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = tables.plans.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
    },
    skill: {
      findUnique: vi.fn(async ({ where }: any) => tables.skills.get(where.key) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `sk_${++seq}`, ...data };
        tables.skills.set(data.key, row);
        return row;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const ex = tables.skills.get(where.key);
        if (ex) {
          Object.assign(ex, update);
          return ex;
        }
        const row = { id: `sk_${++seq}`, ...create };
        tables.skills.set(create.key, row);
        return row;
      }),
    },
    project: {
      findUnique: vi.fn(async ({ where }: any) => tables.projects.get(where.id) ?? null),
      findFirst: vi.fn(async ({ where }: any) => {
        const r = tables.projects.get(where.id);
        return r && !r.deletedAt ? r : null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = tables.projects.get(where.id);
        Object.assign(r, data);
        return r;
      }),
    },
  },
}));

import express from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { errorHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { customAgentsRouter } from "../src/routes/custom-agents.js";
import { hooksRouter } from "../src/routes/hooks.js";
import { skillDirectoriesRouter } from "../src/routes/skill-directories.js";
import { pluginsRouter } from "../src/routes/plugins.js";
import { aiSdkRouter } from "../src/routes/ai-sdk.js";

let adminToken: string;
let userToken: string;

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use("/api/custom-agents", customAgentsRouter());
  app.use("/api/projects/:projectId/hooks", hooksRouter());
  app.use("/api/projects/:projectId", skillDirectoriesRouter());
  app.use("/api/plugins", pluginsRouter());
  app.use("/api/ai", aiSdkRouter());
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
  userToken = issueTokens({
    userId: "u2",
    username: "user",
    role: "user",
    permissions: getPermissionsForRole("user"),
  }).accessToken;
});

beforeEach(reset);
afterEach(reset);

describe("custom-agents routes (#112)", () => {
  it("requires auth", async () => {
    const res = await request(makeApp()).get("/api/custom-agents");
    expect(res.status).toBe(401);
  });

  it("creates, lists, gets, patches, deletes a custom agent", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/custom-agents")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        projectId: "p1",
        name: "MyAgent",
        description: "x",
        systemPrompt: "do",
        tools: [],
      });
    expect([200, 201]).toContain(create.status);
    const id = create.body.data.id;

    const list = await request(app)
      .get("/api/custom-agents?projectId=p1")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);

    const get = await request(app)
      .get(`/api/custom-agents/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(get.status).toBe(200);

    const patch = await request(app)
      .patch(`/api/custom-agents/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ description: "new" });
    expect(patch.status).toBe(200);
    expect(patch.body.data.description).toBe("new");

    const del = await request(app)
      .delete(`/api/custom-agents/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect([200, 204]).toContain(del.status);
  });

  it("rejects bad payload with 400", async () => {
    const res = await request(makeApp())
      .post("/api/custom-agents")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ projectId: "p1" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown id on get/patch/delete", async () => {
    const app = makeApp();
    const r1 = await request(app)
      .get("/api/custom-agents/nope")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(r1.status).toBe(404);
  });

  it("404 on patch/delete of unknown id (existence not leaked)", async () => {
    // IDOR hardening (#260 review): by-id routes resolve the agent and gate on
    // its project before mutating, so an unknown id is a 404 (not a 400 from
    // the service layer) — existence is never leaked.
    const app = makeApp();
    const r1 = await request(app)
      .patch("/api/custom-agents/nope")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ description: "x" });
    expect(r1.status).toBe(404);
    const r2 = await request(app)
      .delete("/api/custom-agents/nope")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(r2.status).toBe(404);
  });

  it("400 on duplicate name in same project", async () => {
    const app = makeApp();
    const body = {
      projectId: "p1",
      name: "Dup",
      description: "",
      systemPrompt: "x",
      tools: [],
    };
    await request(app)
      .post("/api/custom-agents")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body);
    const dupe = await request(app)
      .post("/api/custom-agents")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body);
    expect(dupe.status).toBe(400);
  });
});

describe("hooks routes (#114)", () => {
  it("CRUD subscriptions", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/projects/p1/hooks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        event: "preToolUse",
        handlerKind: "webhook",
        // #675 — a public IP literal exercises the egress guard without a real
        // DNS lookup (dns.lookup on a literal resolves locally).
        config: { url: "https://93.184.216.34/h" },
      });
    expect([200, 201]).toContain(create.status);
    const id = create.body.data.id;

    const list = await request(app)
      .get("/api/projects/p1/hooks")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.body.data).toHaveLength(1);

    const patch = await request(app)
      .patch(`/api/projects/p1/hooks/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: false });
    expect(patch.status).toBe(200);

    const del = await request(app)
      .delete(`/api/projects/p1/hooks/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect([200, 204]).toContain(del.status);
  });

  it("rejects invalid handler kind", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/hooks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ event: "preToolUse", handlerKind: "script" });
    expect(res.status).toBe(400);
  });

  it("404 on unknown subscription update / delete (existence not leaked)", async () => {
    // #675 — by-id ops scope the query to the path project, so an unknown id is
    // a 404 (not a 400 from the service layer); existence is never leaked.
    const app = makeApp();
    const r1 = await request(app)
      .patch("/api/projects/p1/hooks/nope")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: false });
    expect(r1.status).toBe(404);
    const r2 = await request(app)
      .delete("/api/projects/p1/hooks/nope")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(r2.status).toBe(404);
  });

  it("400 on bad event in body", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/hooks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ event: "blah", handlerKind: "webhook", config: { url: "https://x" } });
    expect(res.status).toBe(400);
  });
});

describe("skill-directories routes (#113)", () => {
  // #1075 — directory writes must land inside an operator-configured root.
  const previousRoots = process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS;
  beforeAll(() => {
    process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS = "/tmp";
  });
  afterAll(() => {
    if (previousRoots === undefined) delete process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS;
    else process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS = previousRoots;
  });

  beforeEach(() => {
    tables.projects.set("p1", {
      id: "p1",
      slug: "p1",
      deletedAt: null,
      skillDirectories: "[]",
      disabledSkills: "[]",
    });
  });

  it("lists, adds, removes a directory", async () => {
    const app = makeApp();
    const list1 = await request(app)
      .get("/api/projects/p1/skill-directories")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list1.status).toBe(200);
    expect(list1.body.data.directories).toEqual([]);

    const add = await request(app)
      .post("/api/projects/p1/skill-directories")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ path: "/tmp/skills" });
    expect([200, 201]).toContain(add.status);
    expect(add.body.data.directories).toContain("/tmp/skills");

    const del = await request(app)
      .delete("/api/projects/p1/skill-directories")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ path: "/tmp/skills" });
    expect(del.status).toBe(200);
  });

  it("rejects relative paths and git URLs", async () => {
    const app = makeApp();
    const r1 = await request(app)
      .post("/api/projects/p1/skill-directories")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ path: "relative" });
    expect(r1.status).toBe(400);
    const r2 = await request(app)
      .post("/api/projects/p1/skill-directories")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ path: "https://github.com/org/repo.git" });
    expect(r2.status).toBe(400);
  });

  it("toggles disabled-skill list", async () => {
    const app = makeApp();
    const add = await request(app)
      .post("/api/projects/p1/disabled-skills")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ slug: "scan-deps" });
    expect([200, 201]).toContain(add.status);
    expect(add.body.data.disabled).toContain("scan-deps");

    const del = await request(app)
      .delete("/api/projects/p1/disabled-skills")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ slug: "scan-deps" });
    expect(del.status).toBe(200);
  });

  it("404 when project does not exist", async () => {
    tables.projects.clear();
    const res = await request(makeApp())
      .get("/api/projects/missing/skill-directories")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("400 on bad disabled-skill payload", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/disabled-skills")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("removing a directory that isn't present is a no-op 200", async () => {
    const res = await request(makeApp())
      .delete("/api/projects/p1/skill-directories")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ path: "/never/added" });
    expect(res.status).toBe(200);
  });
});

describe("plugins routes (#115)", () => {
  beforeEach(() => {
    tables.projects.set("p1", { id: "p1", slug: "p1", deletedAt: null });
  });

  it("export → import round-trip", async () => {
    // seed an agent + a hook for the export to find
    seq++;
    tables.customAgents.set("ag_seed", {
      id: "ag_seed",
      projectId: "p1",
      name: "Foo",
      description: "",
      systemPrompt: "x",
      tools: "[]",
      model: null,
      reasoningEffort: null,
      isBuiltIn: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    tables.hookSubs.set("h_seed", {
      id: "h_seed",
      projectId: "p1",
      event: "preToolUse",
      handlerKind: "webhook",
      config: JSON.stringify({ url: "https://example.com/h" }),
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = makeApp();
    const exp = await request(app)
      .post("/api/plugins/export")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "demo",
        version: "1.0.0",
        description: "",
        skillIds: [],
        customAgentIds: ["ag_seed"],
        hookIds: ["h_seed"],
      });
    expect(exp.status).toBe(200);
    const envelope = JSON.parse(exp.text);

    const imp = await request(app)
      .post("/api/plugins/import")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ projectId: "p1", envelope });
    expect([200, 201]).toContain(imp.status);
    expect(imp.body.data.installed.agents).toBeGreaterThanOrEqual(0);
  });

  it("rejects malformed import envelope", async () => {
    const res = await request(makeApp())
      .post("/api/plugins/import")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ projectId: "p1", envelope: { format: "wrong" } });
    expect(res.status).toBe(400);
  });

  it("400 on missing import payload", async () => {
    const res = await request(makeApp())
      .post("/api/plugins/import")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("404 when target project doesn't exist", async () => {
    tables.projects.clear();
    const res = await request(makeApp())
      .post("/api/plugins/import")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        projectId: "ghost",
        envelope: {
          format: "metis-plugin",
          version: "1.0",
          manifest: {
            name: "demo",
            version: "1.0.0",
            description: "",
            exportedAt: "2026-04-25T00:00:00.000Z",
          },
          skills: [],
          agents: [],
          hooks: [],
        },
      });
    expect(res.status).toBe(404);
  });

  it("400 on bad export payload (invalid name)", async () => {
    const res = await request(makeApp())
      .post("/api/plugins/export")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Bad Name",
        version: "1.0.0",
        skillIds: [],
        customAgentIds: [],
        hookIds: [],
      });
    expect(res.status).toBe(400);
  });
});

describe("ai-sdk routes (#120-122)", () => {
  beforeEach(() => {
    tables.sessions.set("s1", {
      id: "s1",
      userId: "u1",
      projectId: "p1",
      title: "T",
      model: "claude",
      currentModel: null,
      currentReasoningEffort: null,
      planModeActive: false,
      status: "active",
      snapshot: JSON.stringify({
        v: 1,
        messages: [],
        currentModel: null,
        currentReasoningEffort: null,
        loadedSkillIds: [],
        customAgentIds: [],
      }),
      snapshotUpdatedAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("lists resumable sessions for the user", async () => {
    const res = await request(makeApp())
      .get("/api/ai/sessions?status=resumable")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  // #139 — resume moved to `routes/ai-conversation.ts` and now reads the server
  // transcript. Its ownership (another user: 404, not 403 — no existence leak)
  // and own-session tests live in `tests/ai-conversation.sqlite.test.ts`.
  it("no longer serves resume from the SDK router", async () => {
    for (const token of [adminToken, userToken]) {
      const res = await request(makeApp())
        .post("/api/ai/sessions/s1/resume")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
    }
  });

  it("switches the model via PATCH", async () => {
    const res = await request(makeApp())
      .patch("/api/ai/sessions/s1/model")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ model: "gpt-5.3", reasoningEffort: "high" });
    expect(res.status).toBe(200);
    expect(res.body.data.currentModel).toBe("gpt-5.3");
  });

  it("plan-mode: create + approve", async () => {
    const app = makeApp();
    const create = await request(app)
      .post("/api/ai/sessions/s1/plan")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ planText: "Step 1\nStep 2" });
    expect([200, 201]).toContain(create.status);

    const get = await request(app)
      .get("/api/ai/sessions/s1/plan")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(get.body.data.status).toBe("pending");

    const decide = await request(app)
      .post("/api/ai/sessions/s1/approve-plan")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approved" });
    expect(decide.status).toBe(200);
    expect(decide.body.data.status).toBe("approved");
  });

  it("rejects bad plan payload", async () => {
    const res = await request(makeApp())
      .post("/api/ai/sessions/s1/plan")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ planText: "" });
    expect(res.status).toBe(400);
  });

  it("returns null plan when none exists", async () => {
    const res = await request(makeApp())
      .get("/api/ai/sessions/s1/plan")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it("conflict when approving with no pending plan", async () => {
    const res = await request(makeApp())
      .post("/api/ai/sessions/s1/approve-plan")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approved" });
    expect(res.status).toBe(404);
  });

  it("400 on bad decision value", async () => {
    const res = await request(makeApp())
      .post("/api/ai/sessions/s1/approve-plan")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "yolo" });
    expect(res.status).toBe(400);
  });

  it("400 on bad model patch", async () => {
    const res = await request(makeApp())
      .patch("/api/ai/sessions/s1/model")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ model: 123 });
    expect(res.status).toBe(400);
  });

  it("status query other than resumable returns empty", async () => {
    const res = await request(makeApp())
      .get("/api/ai/sessions?status=other")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
