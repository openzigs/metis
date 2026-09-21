/**
 * Epic #298 / Issue #313 — project overview route tests.
 *
 * Mocks Prisma in-memory and drives the routes via supertest. Verifies:
 *  - GET returns the cached markdown with 404 fallback when never generated
 *  - POST regenerate persists + returns markdown
 *  - POST regenerate enforces project.update auth (admin/manager only)
 *  - POST returns 409 NO_GRAPH when there is no CodeGraph data
 *  - GET enforces project.read (any reader)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface MockProject {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  createdById: string;
  deletedAt: Date | null;
  overviewMarkdown: string | null;
  overviewGeneratedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
  monthlyTokenBudget: number | null;
  safetyMode: string;
  autopilotEnabled: boolean;
  autopilotCostCeilingCents: number | null;
}

interface MockCodeGraph {
  id: string;
  projectId: string;
  symbolCount: number;
  edgeCount: number;
  languageStats: string;
  lastIndexedAt: Date | null;
  commitSha: string | null;
  updatedAt: Date;
}

interface MockSymbol {
  id: string;
  codeGraphId: string;
  projectId: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
}

interface MockEdge {
  id: string;
  projectId: string;
  fromSymbolId: string;
  toSymbolId: string | null;
  kind: string;
}

interface MockFinding {
  id: string;
  category: string;
  body: string;
  symbolId: string | null;
}

const projects = new Map<string, MockProject>();
const graphs: MockCodeGraph[] = [];
const symbols: MockSymbol[] = [];
const edges: MockEdge[] = [];
const findings: MockFinding[] = [];
const auditCalls: Array<{ action: string; targetId: string }> = [];

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return {
    prisma: withRouteAuth({
      $queryRawUnsafe: vi.fn(async () => 1),
      workspaceMember: { findMany: vi.fn(async () => []) },
      user: {
        upsert: vi.fn(async ({ create }: any) => ({ id: `user_${create.username}`, ...create })),
      },
      userRole: {},
      auditLog: { create: vi.fn(async () => ({})) },
      project: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id) return projects.get(where.id) ?? null;
          if (where.slug) for (const p of projects.values()) if (p.slug === where.slug) return p;
          return null;
        }),
        findFirst: vi.fn(async ({ where, select }: any) => {
          const p = projects.get(where.id);
          if (!p || p.deletedAt) return null;
          if (!select) return p;
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(select)) {
            if (select[k]) out[k] = (p as Record<string, unknown>)[k];
          }
          return out;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const cur = projects.get(where.id);
          if (!cur) throw new Error("not found");
          const next = { ...cur, ...data, updatedAt: new Date() };
          projects.set(where.id, next as MockProject);
          return next;
        }),
      },
      codeGraph: {
        findFirst: vi.fn(async ({ where }: any) => {
          const matches = graphs
            .filter((g) => g.projectId === where.projectId)
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          return matches[0] ?? null;
        }),
      },
      codeSymbol: {
        findMany: vi.fn(async ({ where }: any) => {
          let rows = symbols.slice();
          if (where.id?.in) rows = rows.filter((r) => where.id.in.includes(r.id));
          if (where.projectId) rows = rows.filter((r) => r.projectId === where.projectId);
          if (where.kind?.in) rows = rows.filter((r) => where.kind.in.includes(r.kind));
          return rows.map((r) => ({
            id: r.id,
            qualifiedName: r.qualifiedName,
            kind: r.kind,
            filePath: r.filePath,
            language: r.language,
            startLine: r.startLine,
          }));
        }),
      },
      codeEdge: {
        groupBy: vi.fn(async ({ where }: any) => {
          const buckets = new Map<string | null, number>();
          const allowed = new Set<string>(
            typeof where.kind === "object" && where.kind?.in
              ? where.kind.in
              : typeof where.kind === "string"
                ? [where.kind]
                : ["calls", "references", "imports", "defines"],
          );
          for (const e of edges) {
            if (e.projectId !== where.projectId) continue;
            if (!allowed.has(e.kind)) continue;
            if (!e.toSymbolId) continue;
            buckets.set(e.toSymbolId, (buckets.get(e.toSymbolId) ?? 0) + 1);
          }
          return Array.from(buckets.entries()).map(([toSymbolId, count]) => ({
            toSymbolId,
            _count: { _all: count },
          }));
        }),
        findMany: vi.fn(async () => []),
      },
      finding: {
        findMany: vi.fn(async ({ where }: any) => {
          let rows = findings.slice();
          if (where.category) rows = rows.filter((r) => r.category === where.category);
          if (where.symbolId?.in)
            rows = rows.filter(
              (r) => r.symbolId !== null && where.symbolId.in.includes(r.symbolId),
            );
          return rows.map((r) => ({ body: r.body, category: r.category, symbolId: r.symbolId }));
        }),
      },
    }),
  };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn((entry: { action: string; target: { id: string } }) => {
    auditCalls.push({ action: entry.action, targetId: entry.target.id });
  }),
}));

// Epic #406 (#423) — the regenerate route now streams `job:lifecycle` on the
// `overview-regenerate` kind. Mock the emitter so we can assert started/
// completed/failed without standing up a socket server.
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
vi.mock("../src/lib/socket/job-events.js", () => ({
  jobEvents,
  genericFailureMessage: (kind: string) => `GENERIC:${kind}`,
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { __resetArchiveHooks } from "../src/lib/projects/project-service.js";

let app: ReturnType<typeof createApp>;
let adminToken: string;
let readerToken: string;

async function login(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  expect(res.status, `login failed for ${username}: ${res.text}`).toBe(200);
  return res.body.data.accessToken as string;
}

function seedProject(overrides: Partial<MockProject> = {}): MockProject {
  const id = overrides.id ?? "proj_overview_1";
  const row: MockProject = {
    id,
    name: "Overview Demo",
    slug: "overview-demo",
    description: "",
    status: "active",
    createdById: "user_admin",
    deletedAt: null,
    overviewMarkdown: null,
    overviewGeneratedAt: null,
    monthlyTokenBudget: null,
    safetyMode: "standard",
    autopilotEnabled: false,
    autopilotCostCeilingCents: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  projects.set(id, row);
  return row;
}

function seedGraph(projectId: string, opts?: Partial<MockCodeGraph>) {
  graphs.push({
    id: `graph_${graphs.length + 1}`,
    projectId,
    symbolCount: 5,
    edgeCount: 4,
    languageStats: JSON.stringify({ ts: 5 }),
    lastIndexedAt: new Date(),
    commitSha: "abc",
    updatedAt: new Date(),
    ...opts,
  });
  for (let i = 0; i < 5; i += 1) {
    symbols.push({
      id: `sym_${i}`,
      codeGraphId: graphs[graphs.length - 1].id,
      projectId,
      qualifiedName: `mod::Sym${i}`,
      kind: "function",
      filePath: i === 0 ? "src/index.ts" : "src/lib/util.ts",
      language: "ts",
      startLine: 1,
      endLine: 5,
    });
  }
  for (let i = 1; i < 5; i += 1) {
    edges.push({
      id: `e_${i}`,
      projectId,
      fromSymbolId: `sym_${i}`,
      toSymbolId: `sym_${(i + 2) % 5}`,
      kind: "calls",
    });
  }
}

beforeAll(() => {
  process.env.AI_OFFLINE = "1";
});

beforeEach(async () => {
  projects.clear();
  graphs.length = 0;
  symbols.length = 0;
  edges.length = 0;
  findings.length = 0;
  auditCalls.length = 0;
  __resetArchiveHooks();
  app = createApp();
  adminToken = await login("admin", "password");
  // Mock provider seeds a 'reader' role user — perfect for the project.read-only path.
  readerToken = await login("reader", "password");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/projects/:id/overview", () => {
  it("404s when project is missing", async () => {
    const res = await request(app)
      .get("/api/projects/missing/overview")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("404s with OVERVIEW_NOT_GENERATED when never generated", async () => {
    seedProject();
    const res = await request(app)
      .get("/api/projects/proj_overview_1/overview")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("OVERVIEW_NOT_GENERATED");
  });

  it("returns persisted markdown with generatedAt", async () => {
    const generated = new Date("2026-04-28T12:00:00Z");
    seedProject({
      overviewMarkdown: "# Cached overview",
      overviewGeneratedAt: generated,
    });
    const res = await request(app)
      .get("/api/projects/proj_overview_1/overview")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.markdown).toBe("# Cached overview");
    expect(res.body.data.generatedAt).toBe(generated.toISOString());
  });

  it("is readable by reader role (project.read)", async () => {
    seedProject({ overviewMarkdown: "# Hi" });
    const res = await request(app)
      .get("/api/projects/proj_overview_1/overview")
      .set("Authorization", `Bearer ${readerToken}`);
    expect(res.status).toBe(200);
  });

  it("401s without auth", async () => {
    seedProject({ overviewMarkdown: "# Hi" });
    const res = await request(app).get("/api/projects/proj_overview_1/overview");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/projects/:id/overview/regenerate", () => {
  it("regenerates, persists the markdown, and audits the action", async () => {
    seedProject();
    seedGraph("proj_overview_1");
    const res = await request(app)
      .post("/api/projects/proj_overview_1/overview/regenerate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.markdown).toContain("# Project Overview — Overview Demo");
    expect(res.body.data.generatedAt).toBeTruthy();
    expect(res.body.data.stats.symbolCount).toBe(5);
    // Persisted on the row.
    expect(projects.get("proj_overview_1")!.overviewMarkdown).toContain("Overview Demo");
    expect(projects.get("proj_overview_1")!.overviewGeneratedAt).toBeInstanceOf(Date);
    // Audited.
    expect(auditCalls.some((a) => a.action === "project.overview.regenerate")).toBe(true);
  });

  // ---- Epic #406 (#423): job:lifecycle streaming + jobId ------------------
  it("returns a jobId and emits started → completed (progress + success toast)", async () => {
    seedProject();
    seedGraph("proj_overview_1");
    const res = await request(app)
      .post("/api/projects/proj_overview_1/overview/regenerate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.data.jobId).toBe("string");
    expect(res.body.data.jobId.length).toBeGreaterThan(0);
    expect(jobEvents.started).toHaveBeenCalledWith(
      "overview-regenerate",
      res.body.data.jobId,
      "proj_overview_1",
      expect.any(String),
    );
    expect(jobEvents.completed).toHaveBeenCalledWith(
      "overview-regenerate",
      res.body.data.jobId,
      "proj_overview_1",
      expect.stringContaining("symbols"),
    );
    expect(jobEvents.failed).not.toHaveBeenCalled();
  });

  it("emits a GENERIC failed event on NO_GRAPH — no raw detail leaked (failure toast)", async () => {
    seedProject(); // no graph seeded → NO_GRAPH
    const res = await request(app)
      .post("/api/projects/proj_overview_1/overview/regenerate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NO_GRAPH");
    // The bus terminal message is the GENERIC one (#254), not the raw error.
    expect(jobEvents.failed).toHaveBeenCalledWith(
      "overview-regenerate",
      expect.any(String),
      "proj_overview_1",
      "GENERIC:overview-regenerate",
    );
    expect(jobEvents.completed).not.toHaveBeenCalled();
  });

  it("403s when caller lacks project.update (reader role)", async () => {
    seedProject();
    seedGraph("proj_overview_1");
    const res = await request(app)
      .post("/api/projects/proj_overview_1/overview/regenerate")
      .set("Authorization", `Bearer ${readerToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("404s when project is missing", async () => {
    const res = await request(app)
      .post("/api/projects/missing/overview/regenerate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("409s with NO_GRAPH when the project has no ingested CodeGraph", async () => {
    seedProject();
    const res = await request(app)
      .post("/api/projects/proj_overview_1/overview/regenerate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NO_GRAPH");
  });

  it("completes well under 2 seconds for the seeded fixture (perf gate)", async () => {
    seedProject();
    seedGraph("proj_overview_1");
    const start = Date.now();
    const res = await request(app)
      .post("/api/projects/proj_overview_1/overview/regenerate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    const ms = Date.now() - start;
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(2000);
  });

  it("two consecutive regenerations yield the same markdown body", async () => {
    seedProject();
    seedGraph("proj_overview_1");
    const a = await request(app)
      .post("/api/projects/proj_overview_1/overview/regenerate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    const b = await request(app)
      .post("/api/projects/proj_overview_1/overview/regenerate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data.markdown).toBe(b.body.data.markdown);
  });
});
