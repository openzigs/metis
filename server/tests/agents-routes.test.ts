/**
 * /api/agents HTTP route tests (Issue #124, Epic #119).
 *
 * `runs-and-agents-md-routes.test.ts` covers the AGENTS.md surface; this file
 * covers the agent *library* router (`/api/agents`) over HTTP: list/search/get/
 * versions/diff, create/update/archive/enable/disable/delete, and inline
 * import — asserting success paths, validation/error mapping, auth, and
 * not-found. The agent service is mocked; `AgentServiceError` stays real so the
 * route's error mapping is verified.
 *
 * Provider guardrail (Epic #119): the library service is mocked at its own
 * boundary — Bedrock / local-gemma provider routing is never touched.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const agentService = {
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
const searchLibraryMock = vi.fn();
const importAgentsMock = vi.fn();

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
    importAgents(...args: unknown[]) {
      return importAgentsMock(...args);
    }
  }
  class FakeLoader {
    constructor(public readonly files: unknown) {}
  }
  return {
    ...actual,
    getAgentService: () => agentService,
    searchLibrary: (...args: unknown[]) => searchLibraryMock(...args),
    LibraryImporter: FakeImporter,
    InlineLoader: FakeLoader,
  };
});

import request from "supertest";
import { createApp } from "../src/app.js";
import { AgentServiceError } from "../src/lib/library/agent-service.js";
import { FrontmatterError } from "../src/lib/library/frontmatter.js";

let app: ReturnType<typeof createApp>;
let token: string;

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.AI_OFFLINE = "1";
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(async () => {
  for (const fn of Object.values(agentService)) fn.mockReset();
  searchLibraryMock.mockReset();
  importAgentsMock.mockReset();
  app = createApp();
  token = await login();
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/agents", () => {
  it("rejects anonymous calls with 401", async () => {
    const res = await request(app).get("/api/agents");
    expect(res.status).toBe(401);
  });

  it("lists agents with filters", async () => {
    agentService.list.mockResolvedValue([{ id: "a1" }]);
    const res = await request(app)
      .get("/api/agents?tag=ops&q=bar&includeArchived=1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(agentService.list).toHaveBeenCalledWith({
      tag: "ops",
      query: "bar",
      includeArchived: true,
    });
  });

  it("searches the library", async () => {
    searchLibraryMock.mockResolvedValue([{ id: "a1" }]);
    const res = await request(app)
      .get("/api/agents/search?q=review")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(searchLibraryMock).toHaveBeenCalledWith({
      query: "review",
      tag: undefined,
      kinds: ["agent"],
    });
  });
});

describe("GET /api/agents/:id", () => {
  it("returns 404 when not found", async () => {
    agentService.get.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/agents/missing")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("AGENT_NOT_FOUND");
  });

  it("returns the agent", async () => {
    agentService.get.mockResolvedValue({ id: "a1" });
    const res = await request(app).get("/api/agents/a1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("returns 404 for a missing version", async () => {
    agentService.getVersion.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/agents/a1/versions/v9")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("AGENT_VERSION_NOT_FOUND");
  });

  it("requires left + right for diff", async () => {
    const res = await request(app)
      .get("/api/agents/a1/diff")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("returns a diff", async () => {
    agentService.diff.mockResolvedValue([{ op: "add" }]);
    const res = await request(app)
      .get("/api/agents/a1/diff?left=v1&right=v2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("POST /api/agents", () => {
  it("rejects invalid payloads with 400", async () => {
    const res = await request(app)
      .post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("creates an agent (201)", async () => {
    agentService.create.mockResolvedValue({ id: "a1" });
    const res = await request(app)
      .post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "# Agent\n\nDoes things." });
    expect(res.status).toBe(201);
  });

  it("maps AgentServiceError to its status", async () => {
    agentService.create.mockRejectedValue(new AgentServiceError(409, "AGENT_CONFLICT", "dupe"));
    const res = await request(app)
      .post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "# Agent\n\nDoes things." });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AGENT_CONFLICT");
  });

  it("maps a FrontmatterError to 400 (not 500) and surfaces its code (#467)", async () => {
    agentService.create.mockRejectedValue(
      new FrontmatterError(
        "MISSING_FRONTMATTER",
        "File must begin with a --- YAML frontmatter block",
      ),
    );
    const res = await request(app)
      .post("/api/agents")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "no frontmatter here" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_FRONTMATTER");
  });
});

describe("agent mutations", () => {
  it("patches an agent", async () => {
    agentService.update.mockResolvedValue({ id: "a1" });
    const res = await request(app)
      .patch("/api/agents/a1")
      .set("Authorization", `Bearer ${token}`)
      .send({ source: "# Updated\n\nbody" });
    expect(res.status).toBe(200);
  });

  it("archives an agent", async () => {
    agentService.archive.mockResolvedValue({ id: "a1" });
    const res = await request(app)
      .post("/api/agents/a1/archive")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("enables + disables an agent", async () => {
    agentService.setEnabled.mockResolvedValue({ id: "a1" });
    const enable = await request(app)
      .post("/api/agents/a1/enable")
      .set("Authorization", `Bearer ${token}`);
    expect(enable.status).toBe(200);
    const disable = await request(app)
      .post("/api/agents/a1/disable")
      .set("Authorization", `Bearer ${token}`);
    expect(disable.status).toBe(200);
  });

  it("deletes an agent (204)", async () => {
    agentService.remove.mockResolvedValue(undefined);
    const res = await request(app).delete("/api/agents/a1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
  });
});

describe("POST /api/agents/import/inline", () => {
  it("rejects an empty file list with 400", async () => {
    const res = await request(app)
      .post("/api/agents/import/inline")
      .set("Authorization", `Bearer ${token}`)
      .send({ files: [] });
    expect(res.status).toBe(400);
  });

  it("imports inline agents (201)", async () => {
    importAgentsMock.mockResolvedValue({ imported: 1, skipped: 0 });
    const res = await request(app)
      .post("/api/agents/import/inline")
      .set("Authorization", `Bearer ${token}`)
      .send({ files: [{ path: "a.md", contents: "# Agent\n\nbody" }] });
    expect(res.status).toBe(201);
    expect(res.body.data.imported).toBe(1);
  });
});
