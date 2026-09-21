/**
 * /api/skills + /api/agents + /api/library route smoke tests.
 *
 * Mocks the prisma module with the in-memory fake store. The dev "offline"
 * auth provider is enabled by default in test mode and grants admin role to
 * any login \u2014 we only need to drive POST /api/auth/login to mint a JWT.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../../src/lib/prisma.js", async () => {
  const { fakePrisma } = await import("./fake-prisma.js");
  const { withRouteAuth } = await import("../helpers/route-auth-prisma.js");
  return { prisma: withRouteAuth({ ...fakePrisma, userRole: {} }) };
});

import { fakePrisma, resetStore, stubAgentToolRegistry } from "./fake-prisma.js";
import { createApp } from "../../src/app.js";
import { __setSkillService, SkillService } from "../../src/lib/library/skill-service.js";
import { __setAgentService, AgentService } from "../../src/lib/library/agent-service.js";
import { __setSessionRuntime, SessionRuntime } from "../../src/lib/library/session-runtime.js";

const SKILL_SOURCE = `---
name: alpha
description: Alpha skill
version: 1.0.0
tags: [shared]
---

Body
`;

const AGENT_SOURCE = `---
name: alpha-agent
displayName: Alpha
description: Alpha agent
version: 1.0.0
model: gpt
---

System prompt
`;

let app: ReturnType<typeof createApp>;

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  resetStore();
  __setSkillService(new SkillService(fakePrisma as never));
  __setAgentService(new AgentService(fakePrisma as never, stubAgentToolRegistry));
  __setSessionRuntime(new SessionRuntime({ db: fakePrisma as never }));
  app = createApp();
});

afterEach(() => {
  __setSkillService(null);
  __setAgentService(null);
  __setSessionRuntime(null);
  vi.clearAllMocks();
});

describe("/api/skills", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/skills");
    expect(res.status).toBe(401);
  });

  it("admin can list, create, update, archive, delete a skill", async () => {
    const token = await login();
    const empty = await request(app).get("/api/skills").set("Authorization", `Bearer ${token}`);
    expect(empty.status).toBe(200);
    expect(empty.body.data.items).toEqual([]);

    const created = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: SKILL_SOURCE });
    expect(created.status).toBe(201);
    const skillId = created.body.data.id;

    const got = await request(app)
      .get(`/api/skills/${skillId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(got.status).toBe(200);

    const updated = await request(app)
      .patch(`/api/skills/${skillId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ source: SKILL_SOURCE.replace("Body", "Body v2") });
    expect(updated.status).toBe(200);
    expect(updated.body.data.version).toBe("1.0.1");

    const versions = await request(app)
      .get(`/api/skills/${skillId}/versions`)
      .set("Authorization", `Bearer ${token}`);
    expect(versions.status).toBe(200);
    expect(versions.body.data.items).toHaveLength(2);

    const disabled = await request(app)
      .post(`/api/skills/${skillId}/disable`)
      .set("Authorization", `Bearer ${token}`);
    expect(disabled.status).toBe(200);

    const archived = await request(app)
      .post(`/api/skills/${skillId}/archive`)
      .set("Authorization", `Bearer ${token}`);
    expect(archived.status).toBe(200);

    const removed = await request(app)
      .delete(`/api/skills/${skillId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(removed.status).toBe(204);
  });

  it("400s on invalid payload", async () => {
    const token = await login();
    const res = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "" });
    expect(res.status).toBe(400);
  });

  it("404s on missing skill", async () => {
    const token = await login();
    const res = await request(app)
      .get("/api/skills/missing")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("/api/agents", () => {
  it("admin can create + fetch an agent", async () => {
    const token = await login();
    const created = await request(app)
      .post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: AGENT_SOURCE });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const got = await request(app).get(`/api/agents/${id}`).set("Authorization", `Bearer ${token}`);
    expect(got.status).toBe(200);
  });

  it("400s on missing source", async () => {
    const token = await login();
    const res = await request(app)
      .post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("/api/library", () => {
  it("returns combined hits from skills + agents", async () => {
    const token = await login();
    await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: SKILL_SOURCE });
    await request(app)
      .post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: AGENT_SOURCE });
    const res = await request(app)
      .get("/api/library?q=alpha")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by kind and tag", async () => {
    const token = await login();
    await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: SKILL_SOURCE });
    const onlySkills = await request(app)
      .get("/api/library?kind=skill&tag=shared")
      .set("Authorization", `Bearer ${token}`);
    expect(onlySkills.status).toBe(200);
    expect(onlySkills.body.data.items.every((h: { kind: string }) => h.kind === "skill")).toBe(
      true,
    );
  });
});

describe("skills route extras", () => {
  it("supports search, version detail, diff, import, and load endpoints", async () => {
    const token = await login();
    const created = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: SKILL_SOURCE });
    expect(created.status).toBe(201);
    const skillId = created.body.data.id;

    await request(app)
      .patch(`/api/skills/${skillId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ source: SKILL_SOURCE.replace("Body", "Body v2") });

    const versions = await request(app)
      .get(`/api/skills/${skillId}/versions`)
      .set("Authorization", `Bearer ${token}`);
    const [a, b] = versions.body.data.items;

    const detail = await request(app)
      .get(`/api/skills/${skillId}/versions/${a.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);

    const diff = await request(app)
      .get(`/api/skills/${skillId}/diff?left=${a.id}&right=${b.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(diff.status).toBe(200);

    const diffMissing = await request(app)
      .get(`/api/skills/${skillId}/diff`)
      .set("Authorization", `Bearer ${token}`);
    expect(diffMissing.status).toBe(400);

    const search = await request(app)
      .get("/api/skills/search?q=alpha")
      .set("Authorization", `Bearer ${token}`);
    expect(search.status).toBe(200);

    const imported = await request(app)
      .post("/api/skills/import/inline")
      .set("Authorization", `Bearer ${token}`)
      .send({ files: [{ path: "x.md", contents: SKILL_SOURCE.replace("alpha", "imported") }] });
    expect(imported.status).toBe(201);
    expect(imported.body.data.imported).toHaveLength(1);

    // create a session and load the skill into it
    const session = await fakePrisma.aISession.create({
      data: {
        userId: "user_admin",
        projectId: null,
        title: "t",
        provider: "p",
        model: "m",
        policy: "{}",
      },
    });
    const loaded = await request(app)
      .post(`/api/skills/${skillId}/load`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId: session.id });
    expect(loaded.status).toBe(200);
    const loadedAgain = await request(app)
      .post(`/api/skills/${skillId}/load`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId: session.id });
    expect(loadedAgain.body.data.alreadyLoaded).toBe(true);

    const noBody = await request(app)
      .post(`/api/skills/${skillId}/load`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(noBody.status).toBe(400);
  });

  it("404 on missing version, returns archive/enable lifecycle responses", async () => {
    const token = await login();
    const created = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: SKILL_SOURCE });
    const id = created.body.data.id;
    const missing = await request(app)
      .get(`/api/skills/${id}/versions/none`)
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);
    const enabled = await request(app)
      .post(`/api/skills/${id}/enable`)
      .set("Authorization", `Bearer ${token}`);
    expect(enabled.status).toBe(200);
    const archived = await request(app)
      .post(`/api/skills/${id}/archive`)
      .set("Authorization", `Bearer ${token}`);
    expect(archived.status).toBe(200);
  });

  it("400 on invalid update payload", async () => {
    const token = await login();
    const created = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: SKILL_SOURCE });
    const id = created.body.data.id;
    const bad = await request(app)
      .patch(`/api/skills/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "" });
    expect(bad.status).toBe(400);
  });
});

describe("agents route extras", () => {
  it("supports patch + archive + enable + disable + delete", async () => {
    const token = await login();
    const created = await request(app)
      .post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: AGENT_SOURCE });
    const id = created.body.data.id;
    const updated = await request(app)
      .patch(`/api/agents/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ source: AGENT_SOURCE.replace("System", "Updated") });
    expect(updated.status).toBe(200);
    const versions = await request(app)
      .get(`/api/agents/${id}/versions`)
      .set("Authorization", `Bearer ${token}`);
    expect(versions.body.data.items).toHaveLength(2);
    const disabled = await request(app)
      .post(`/api/agents/${id}/disable`)
      .set("Authorization", `Bearer ${token}`);
    expect(disabled.status).toBe(200);
    const enabled = await request(app)
      .post(`/api/agents/${id}/enable`)
      .set("Authorization", `Bearer ${token}`);
    expect(enabled.status).toBe(200);
    const archived = await request(app)
      .post(`/api/agents/${id}/archive`)
      .set("Authorization", `Bearer ${token}`);
    expect(archived.status).toBe(200);
    const removed = await request(app)
      .delete(`/api/agents/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(removed.status).toBe(204);
  });

  it("returns 404 for missing agent + supports inline import", async () => {
    const token = await login();
    const missing = await request(app)
      .get("/api/agents/nope")
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);
    const imported = await request(app)
      .post("/api/agents/import/inline")
      .set("Authorization", `Bearer ${token}`)
      .send({ files: [{ path: "a.md", contents: AGENT_SOURCE }] });
    expect(imported.status).toBe(201);
    expect(imported.body.data.imported).toHaveLength(1);
  });

  it("supports search + version detail + diff + invalid payloads", async () => {
    const token = await login();
    const created = await request(app)
      .post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: AGENT_SOURCE });
    const id = created.body.data.id;
    await request(app)
      .patch(`/api/agents/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ source: AGENT_SOURCE.replace("System", "Updated") });

    const versions = await request(app)
      .get(`/api/agents/${id}/versions`)
      .set("Authorization", `Bearer ${token}`);
    const [a, b] = versions.body.data.items;

    const detail = await request(app)
      .get(`/api/agents/${id}/versions/${a.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);

    const detailMissing = await request(app)
      .get(`/api/agents/${id}/versions/none`)
      .set("Authorization", `Bearer ${token}`);
    expect(detailMissing.status).toBe(404);

    const diff = await request(app)
      .get(`/api/agents/${id}/diff?left=${a.id}&right=${b.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(diff.status).toBe(200);

    const diffBad = await request(app)
      .get(`/api/agents/${id}/diff`)
      .set("Authorization", `Bearer ${token}`);
    expect(diffBad.status).toBe(400);

    const search = await request(app)
      .get("/api/agents/search?q=alpha")
      .set("Authorization", `Bearer ${token}`);
    expect(search.status).toBe(200);

    const list = await request(app)
      .get("/api/agents?includeArchived=1")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);

    const badPatch = await request(app)
      .patch(`/api/agents/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "" });
    expect(badPatch.status).toBe(400);

    const badImport = await request(app)
      .post("/api/agents/import/inline")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(badImport.status).toBe(400);
  });
});

describe("/api/projects/:projectId/library", () => {
  it("404s when the project doesn't exist", async () => {
    const token = await login();
    const skill = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: SKILL_SOURCE });
    const res = await request(app)
      .put(`/api/projects/missing/library/skills/${skill.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: true });
    expect(res.status).toBe(404);
  });

  it("can list, enable, disable, and remove skills/agents on the allowlist", async () => {
    const token = await login();
    const skill = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: SKILL_SOURCE });
    const agent = await request(app)
      .post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: AGENT_SOURCE });

    const project = await fakePrisma.project.create({
      data: { name: "p", slug: "p", status: "active", createdById: "user_admin" },
    });

    const enableSkill = await request(app)
      .put(`/api/projects/${project.id}/library/skills/${skill.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: true });
    expect(enableSkill.status).toBe(204);

    const enableAgent = await request(app)
      .put(`/api/projects/${project.id}/library/agents/${agent.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: false });
    expect(enableAgent.status).toBe(204);

    const skills = await request(app)
      .get(`/api/projects/${project.id}/library/skills`)
      .set("Authorization", `Bearer ${token}`);
    expect(skills.body.data.items).toHaveLength(1);

    const agents = await request(app)
      .get(`/api/projects/${project.id}/library/agents`)
      .set("Authorization", `Bearer ${token}`);
    expect(agents.body.data.items).toHaveLength(1);

    const removeSkill = await request(app)
      .delete(`/api/projects/${project.id}/library/skills/${skill.body.data.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(removeSkill.status).toBe(204);

    const removeAgent = await request(app)
      .delete(`/api/projects/${project.id}/library/agents/${agent.body.data.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(removeAgent.status).toBe(204);

    const badPut = await request(app)
      .put(`/api/projects/${project.id}/library/skills/${skill.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(badPut.status).toBe(400);
  });

  it("GET /skills/available returns the resolved (default-allowed) skills (#468)", async () => {
    const token = await login();
    const skill = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: SKILL_SOURCE });
    const project = await fakePrisma.project.create({
      data: { name: "pa", slug: "pa", status: "active", createdById: "user_admin" },
    });

    // No explicit allowlist rows → the enabled skill is available by default,
    // even though GET /skills (explicit rows) would be empty.
    const explicit = await request(app)
      .get(`/api/projects/${project.id}/library/skills`)
      .set("Authorization", `Bearer ${token}`);
    expect(explicit.body.data.items).toHaveLength(0);

    const available = await request(app)
      .get(`/api/projects/${project.id}/library/skills/available`)
      .set("Authorization", `Bearer ${token}`);
    expect(available.status).toBe(200);
    const ids = available.body.data.items.map((i: { skillId: string }) => i.skillId);
    expect(ids).toContain(skill.body.data.id);
    expect(available.body.data.items[0]).toHaveProperty("skillKey");
    expect(available.body.data.items[0]).toHaveProperty("name");
  });
});
