/**
 * /api/skills HTTP route tests (Issue #130, Epic #119).
 *
 * Exercises the skills library router over HTTP: list/search/get/versions/diff,
 * create/update/archive/enable/disable/delete, inline import, and session
 * load — asserting success paths, validation/error mapping, auth, and
 * not-found. The skill service + session runtime are mocked; error classes are
 * kept real so the route's `SkillServiceError → AppError` mapping is verified.
 *
 * Provider guardrail (Epic #119): the library service is mocked at its own
 * boundary — Bedrock / local-gemma provider routing is never touched.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const skillService = {
  list: vi.fn(),
  get: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  diff: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  setEnabled: vi.fn(),
  remove: vi.fn(),
};
const sessionRuntime = { loadSkillIntoSession: vi.fn() };
const searchLibraryMock = vi.fn();
const importSkillsMock = vi.fn();

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: "user_admin",
        ...create,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

vi.mock("../src/lib/library/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/library/index.js")>(
    "../src/lib/library/index.js",
  );
  class FakeImporter {
    importSkills(...args: unknown[]) {
      return importSkillsMock(...args);
    }
  }
  class FakeLoader {
    constructor(public readonly files: unknown) {}
  }
  return {
    ...actual,
    getSkillService: () => skillService,
    getSessionRuntime: () => sessionRuntime,
    searchLibrary: (...args: unknown[]) => searchLibraryMock(...args),
    LibraryImporter: FakeImporter,
    InlineLoader: FakeLoader,
  };
});

import request from "supertest";
import { createApp } from "../src/app.js";
import { SkillServiceError } from "../src/lib/library/skill-service.js";
import { FrontmatterError } from "../src/lib/library/frontmatter.js";

let app: ReturnType<typeof createApp>;
let token: string;

async function login(username = "admin"): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.AI_OFFLINE = "1";
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(async () => {
  for (const fn of Object.values(skillService)) fn.mockReset();
  sessionRuntime.loadSkillIntoSession.mockReset();
  searchLibraryMock.mockReset();
  importSkillsMock.mockReset();
  app = createApp();
  token = await login();
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/skills", () => {
  it("rejects anonymous calls with 401", async () => {
    const res = await request(app).get("/api/skills");
    expect(res.status).toBe(401);
  });

  it("lists skills with filters", async () => {
    skillService.list.mockResolvedValue([{ id: "s1", name: "Doc" }]);
    const res = await request(app)
      .get("/api/skills?tag=docs&q=foo&includeArchived=1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(skillService.list).toHaveBeenCalledWith({
      tag: "docs",
      query: "foo",
      includeArchived: true,
    });
  });

  it("searches the library", async () => {
    searchLibraryMock.mockResolvedValue([{ id: "s1" }]);
    const res = await request(app)
      .get("/api/skills/search?q=auth")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(searchLibraryMock).toHaveBeenCalledWith({
      query: "auth",
      tag: undefined,
      kinds: ["skill"],
    });
  });
});

describe("GET /api/skills/:id", () => {
  it("returns 404 when not found", async () => {
    skillService.get.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/skills/missing")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SKILL_NOT_FOUND");
  });

  it("returns the skill", async () => {
    skillService.get.mockResolvedValue({ id: "s1", name: "Doc" });
    const res = await request(app).get("/api/skills/s1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("s1");
  });

  it("lists versions", async () => {
    skillService.listVersions.mockResolvedValue([{ id: "v1" }]);
    const res = await request(app)
      .get("/api/skills/s1/versions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  it("returns 404 for a missing version", async () => {
    skillService.getVersion.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/skills/s1/versions/v9")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SKILL_VERSION_NOT_FOUND");
  });

  it("requires left + right for diff", async () => {
    const res = await request(app)
      .get("/api/skills/s1/diff?left=v1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("returns a diff", async () => {
    skillService.diff.mockResolvedValue([{ op: "add" }]);
    const res = await request(app)
      .get("/api/skills/s1/diff?left=v1&right=v2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("POST /api/skills", () => {
  it("rejects invalid payloads with 400", async () => {
    const res = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "no" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("creates a skill (201)", async () => {
    skillService.create.mockResolvedValue({ id: "s1", name: "Doc" });
    const res = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "# A skill\n\nDoes things." });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe("s1");
  });

  it("maps SkillServiceError to its status", async () => {
    skillService.create.mockRejectedValue(new SkillServiceError(409, "SKILL_CONFLICT", "dupe"));
    const res = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "# A skill\n\nDoes things." });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SKILL_CONFLICT");
  });

  it("maps a FrontmatterError to 400 (not 500) and surfaces its code (#467)", async () => {
    skillService.create.mockRejectedValue(
      new FrontmatterError("YAML_PARSE_ERROR", "YAML parse failed: bad indentation (1:7)"),
    );
    const res = await request(app)
      .post("/api/skills")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "---\nbad: : :\n---\nbody" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("YAML_PARSE_ERROR");
  });
});

describe("mutations", () => {
  it("patches a skill", async () => {
    skillService.update.mockResolvedValue({ id: "s1" });
    const res = await request(app)
      .patch("/api/skills/s1")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "# Updated\n\nbody" });
    expect(res.status).toBe(200);
  });

  it("archives a skill", async () => {
    skillService.archive.mockResolvedValue({ id: "s1", archived: true });
    const res = await request(app)
      .post("/api/skills/s1/archive")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("enables + disables a skill", async () => {
    skillService.setEnabled.mockResolvedValue({ id: "s1" });
    const enable = await request(app)
      .post("/api/skills/s1/enable")
      .set("Authorization", `Bearer ${token}`);
    expect(enable.status).toBe(200);
    const disable = await request(app)
      .post("/api/skills/s1/disable")
      .set("Authorization", `Bearer ${token}`);
    expect(disable.status).toBe(200);
  });

  it("deletes a skill (204)", async () => {
    skillService.remove.mockResolvedValue(undefined);
    const res = await request(app).delete("/api/skills/s1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
  });
});

describe("POST /api/skills/import/inline", () => {
  it("rejects an empty file list with 400", async () => {
    const res = await request(app)
      .post("/api/skills/import/inline")
      .set("Authorization", `Bearer ${token}`)
      .send({ files: [] });
    expect(res.status).toBe(400);
  });

  it("imports inline skills (201)", async () => {
    importSkillsMock.mockResolvedValue({ imported: 1, skipped: 0 });
    const res = await request(app)
      .post("/api/skills/import/inline")
      .set("Authorization", `Bearer ${token}`)
      .send({ files: [{ path: "a.md", contents: "# Skill\n\nbody" }] });
    expect(res.status).toBe(201);
    expect(res.body.data.imported).toBe(1);
  });
});

describe("POST /api/skills/:id/load", () => {
  it("requires a sessionId", async () => {
    const res = await request(app)
      .post("/api/skills/s1/load")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("loads a skill into a session", async () => {
    sessionRuntime.loadSkillIntoSession.mockResolvedValue({ alreadyLoaded: false });
    const res = await request(app)
      .post("/api/skills/s1/load")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId: "sess_1" });
    expect(res.status).toBe(200);
    expect(res.body.data.alreadyLoaded).toBe(false);
  });
});
