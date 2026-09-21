/**
 * Issue #1075 (epic #1051) — RBAC + path-allowlist regression suite for
 * `/projects/:projectId/skill-directories` and `/projects/:projectId/disabled-skills`.
 *
 * Before this suite the whole router gated on `requireAuth` alone, so the
 * lowest-privileged member of a project (`reader`, read-only by design in
 * `packages/shared/src/rbac.ts`) could write an operator-supplied filesystem
 * path into `Project.skillDirectories` and toggle the disabled-skill list.
 *
 * Two properties are asserted here, and BOTH matter:
 *   • writes are unreachable for `reader` / `developer` (privilege escalation);
 *   • every role that is *supposed* to keep working still does — reads for
 *     everyone, disabled-skills for `coordinator`, directories for `admin`.
 *     Over-blocking is a regression too (see #1056).
 *
 * The suite runs the REAL auth + permission middleware; only Prisma is mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const projects = new Map<string, Record<string, unknown>>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = projects.get(where.id);
          if (!row) throw new Error("not found");
          Object.assign(row, data);
          return row;
        },
      ),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import express from "express";
import request from "supertest";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";
import { errorHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { skillDirectoriesRouter } from "../src/routes/skill-directories.js";

/** Operator-configured root that the tests treat as the only allowed location. */
const ALLOWED_ROOT_PARENT = os.tmpdir();
const ALLOWED_ROOT = path.join(ALLOWED_ROOT_PARENT, "metis-1075-skill-roots");
const INSIDE_ROOT = path.join(ALLOWED_ROOT, "team-skills");

const originalRootsEnv = process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS;

const tokens: Record<RoleKey, string> = {} as Record<RoleKey, string>;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId", skillDirectoriesRouter());
  app.use(errorHandler);
  return app;
}

function auth(role: RoleKey) {
  return `Bearer ${tokens[role]}`;
}

beforeAll(() => {
  process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS = ALLOWED_ROOT;
  for (const role of ["reader", "developer", "coordinator", "admin"] as const) {
    tokens[role] = issueTokens({
      userId: `u_${role}`,
      username: role,
      role,
      permissions: getPermissionsForRole(role),
    }).accessToken;
  }
});

afterAll(() => {
  if (originalRootsEnv === undefined) delete process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS;
  else process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS = originalRootsEnv;
});

beforeEach(() => {
  projects.clear();
  projects.set("p1", {
    id: "p1",
    slug: "p1",
    deletedAt: null,
    skillDirectories: JSON.stringify([INSIDE_ROOT]),
    disabledSkills: JSON.stringify(["already-off"]),
  });
});

describe("#1075 — skill-directories writes are role-gated", () => {
  const denied: Array<[RoleKey, string]> = [
    ["reader", "reader"],
    ["developer", "developer"],
  ];

  for (const [role] of denied) {
    it(`403s a ${role} adding a skill directory`, async () => {
      const res = await request(makeApp())
        .post("/api/projects/p1/skill-directories")
        .set("Authorization", auth(role))
        .send({ path: INSIDE_ROOT });
      expect(res.status).toBe(403);
    });

    it(`403s a ${role} removing a skill directory`, async () => {
      const res = await request(makeApp())
        .delete("/api/projects/p1/skill-directories")
        .set("Authorization", auth(role))
        .send({ path: INSIDE_ROOT });
      expect(res.status).toBe(403);
    });

    it(`403s a ${role} disabling a skill`, async () => {
      const res = await request(makeApp())
        .post("/api/projects/p1/disabled-skills")
        .set("Authorization", auth(role))
        .send({ slug: "scan-deps" });
      expect(res.status).toBe(403);
    });

    it(`403s a ${role} re-enabling a skill`, async () => {
      const res = await request(makeApp())
        .delete("/api/projects/p1/disabled-skills")
        .set("Authorization", auth(role))
        .send({ slug: "already-off" });
      expect(res.status).toBe(403);
    });
  }

  it("leaves the stored configuration untouched after a denied write", async () => {
    await request(makeApp())
      .post("/api/projects/p1/skill-directories")
      .set("Authorization", auth("reader"))
      .send({ path: INSIDE_ROOT });
    expect(projects.get("p1")!.skillDirectories).toBe(JSON.stringify([INSIDE_ROOT]));
  });

  it("still 401s an unauthenticated caller", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/skill-directories")
      .send({ path: INSIDE_ROOT });
    expect(res.status).toBe(401);
  });
});

describe("#1075 — authorized roles are not over-blocked", () => {
  for (const role of ["reader", "developer", "coordinator", "admin"] as const) {
    it(`lets a ${role} read the configured directories`, async () => {
      const res = await request(makeApp())
        .get("/api/projects/p1/skill-directories")
        .set("Authorization", auth(role));
      expect(res.status).toBe(200);
      expect(res.body.data.directories).toEqual([INSIDE_ROOT]);
    });

    it(`lets a ${role} read the disabled-skill list`, async () => {
      const res = await request(makeApp())
        .get("/api/projects/p1/disabled-skills")
        .set("Authorization", auth(role));
      expect(res.status).toBe(200);
      expect(res.body.data.disabled).toEqual(["already-off"]);
    });
  }

  for (const role of ["coordinator", "admin"] as const) {
    it(`lets a ${role} toggle the disabled-skill list`, async () => {
      const app = makeApp();
      const off = await request(app)
        .post("/api/projects/p1/disabled-skills")
        .set("Authorization", auth(role))
        .send({ slug: "scan-deps" });
      expect(off.status).toBe(201);
      expect(off.body.data.disabled).toContain("scan-deps");

      const on = await request(app)
        .delete("/api/projects/p1/disabled-skills")
        .set("Authorization", auth(role))
        .send({ slug: "scan-deps" });
      expect(on.status).toBe(200);
      expect(on.body.data.disabled).not.toContain("scan-deps");
    });
  }

  it("lets an admin add and remove a skill directory", async () => {
    const app = makeApp();
    const other = path.join(ALLOWED_ROOT, "ops-skills");
    const add = await request(app)
      .post("/api/projects/p1/skill-directories")
      .set("Authorization", auth("admin"))
      .send({ path: other });
    expect(add.status).toBe(201);
    expect(add.body.data.directories).toContain(other);

    const del = await request(app)
      .delete("/api/projects/p1/skill-directories")
      .set("Authorization", auth("admin"))
      .send({ path: other });
    expect(del.status).toBe(200);
    expect(del.body.data.directories).not.toContain(other);
  });
});

describe("#1075 — the gates run before the handler, not instead of it", () => {
  const writes: Array<[string, "post" | "delete", string, Record<string, string>, RoleKey]> = [
    ["POST /skill-directories", "post", "skill-directories", { path: INSIDE_ROOT }, "admin"],
    ["DELETE /skill-directories", "delete", "skill-directories", { path: INSIDE_ROOT }, "admin"],
    ["POST /disabled-skills", "post", "disabled-skills", { slug: "s" }, "coordinator"],
    ["DELETE /disabled-skills", "delete", "disabled-skills", { slug: "s" }, "coordinator"],
  ];

  for (const [label, method, segment, body, role] of writes) {
    it(`${label} still 404s an authorized caller when the project is gone`, async () => {
      projects.clear();
      const res = await request(makeApp())
        [method](`/api/projects/p1/${segment}`)
        .set("Authorization", auth(role))
        .send(body);
      expect(res.status).toBe(404);
    });

    it(`${label} still 400s an authorized caller on a malformed payload`, async () => {
      const res = await request(makeApp())
        [method](`/api/projects/p1/${segment}`)
        .set("Authorization", auth(role))
        .send({});
      expect(res.status).toBe(400);
    });
  }

  for (const segment of ["skill-directories", "disabled-skills"] as const) {
    it(`GET /${segment} still 404s when the project is gone`, async () => {
      projects.clear();
      const res = await request(makeApp())
        .get(`/api/projects/p1/${segment}`)
        .set("Authorization", auth("reader"));
      expect(res.status).toBe(404);
    });
  }

  it("tolerates a column that is not valid JSON", async () => {
    projects.set("p1", {
      id: "p1",
      deletedAt: null,
      skillDirectories: "{oops",
      disabledSkills: "",
    });
    const res = await request(makeApp())
      .get("/api/projects/p1/skill-directories")
      .set("Authorization", auth("reader"));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ directories: [], disabled: [] });
  });

  it("adding a directory that is already configured is idempotent", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/skill-directories")
      .set("Authorization", auth("admin"))
      .send({ path: INSIDE_ROOT });
    expect(res.status).toBe(201);
    expect(res.body.data.directories).toEqual([INSIDE_ROOT]);
  });

  it("disabling a skill that is already disabled is idempotent", async () => {
    const res = await request(makeApp())
      .post("/api/projects/p1/disabled-skills")
      .set("Authorization", auth("coordinator"))
      .send({ slug: "already-off" });
    expect(res.status).toBe(201);
    expect(res.body.data.disabled).toEqual(["already-off"]);
  });
});

describe("#1075 — submitted paths are confined to the allowed roots", () => {
  const rejected: Array<[string, string]> = [
    ["an absolute path outside every allowed root", "/etc"],
    ["a traversal that climbs out of the root", `${ALLOWED_ROOT}/../../etc`],
    ["a sibling directory sharing the root's prefix", `${ALLOWED_ROOT}-evil`],
    ["the filesystem root", "/"],
  ];

  for (const [label, candidate] of rejected) {
    it(`400s ${label}`, async () => {
      const res = await request(makeApp())
        .post("/api/projects/p1/skill-directories")
        .set("Authorization", auth("admin"))
        .send({ path: candidate });
      expect(res.status).toBe(400);
      expect(projects.get("p1")!.skillDirectories).toBe(JSON.stringify([INSIDE_ROOT]));
    });
  }

  it("scans a directory inside the root and reports what it discovered", async () => {
    const root = await fs.mkdtemp(path.join(ALLOWED_ROOT_PARENT, "metis-1075-scan-"));
    process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS = root;
    try {
      await fs.mkdir(path.join(root, "scan-deps"), { recursive: true });
      await fs.writeFile(
        path.join(root, "scan-deps", "SKILL.md"),
        "---\nname: scan-deps\n---\nScans dependency files.\n",
      );
      projects.set("p1", {
        id: "p1",
        deletedAt: null,
        skillDirectories: JSON.stringify([root]),
        disabledSkills: "[]",
      });
      const res = await request(makeApp())
        .get("/api/projects/p1/skill-directories")
        .set("Authorization", auth("reader"));
      expect(res.status).toBe(200);
      expect(res.body.data.discovered).toEqual([
        { slug: "scan-deps", excerpt: "Scans dependency files.", directorySource: root },
      ]);
      expect(res.body.data.errors).toEqual([]);
    } finally {
      process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS = ALLOWED_ROOT;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces a stored out-of-root directory as an error instead of scanning it", async () => {
    projects.set("p1", {
      id: "p1",
      deletedAt: null,
      skillDirectories: JSON.stringify(["/etc"]),
      disabledSkills: "[]",
    });
    const res = await request(makeApp())
      .get("/api/projects/p1/skill-directories")
      .set("Authorization", auth("admin"));
    expect(res.status).toBe(200);
    expect(res.body.data.discovered).toEqual([]);
    expect(res.body.data.errors).toEqual([
      { root: "/etc", error: expect.stringContaining("allowed skill roots") },
    ]);
  });

  it("accepts the allowed root itself and a directory beneath it", async () => {
    const app = makeApp();
    const rootItself = await request(app)
      .post("/api/projects/p1/skill-directories")
      .set("Authorization", auth("admin"))
      .send({ path: ALLOWED_ROOT });
    expect(rootItself.status).toBe(201);

    const nested = await request(app)
      .post("/api/projects/p1/skill-directories")
      .set("Authorization", auth("admin"))
      .send({ path: path.join(ALLOWED_ROOT, "a", "b") });
    expect(nested.status).toBe(201);
  });
});
