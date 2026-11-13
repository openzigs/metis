/**
 * Epic #609 (#619) — `/api/projects/:id/review-gate` settings routes.
 *
 * The per-project `requireApprovedReview` flag powers the publish/export
 * approval gate. RBAC under test (real `requirePermission` + shared
 * registry):
 *   - GET requires `project.read` (all roles).
 *   - PATCH requires `review.admin` (coordinator/admin only) — a developer
 *     with draft/publish permissions must NOT be able to weaken the gate.
 * Default under test: a fresh project reports `requireApprovedReview: false`
 * (gate off — pre-#619 behavior).
 *
 * #2436 — the same route carries `allowSelfApproval` (maker-checker), off by
 * default; a change of it is audited as `project.selfApproval.update` with its
 * old and new value. #2453 — only an admin may change it (a coordinator holds
 * `review.admin` but is bound by maker-checker); a refused attempt is audited
 * as `project.selfApproval.denied`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface ProjectRow {
  id: string;
  requireApprovedReview: boolean;
  allowSelfApproval: boolean;
}

const projects = new Map<string, ProjectRow>();

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({ id: `user_${create.username}`, ...create }),
      ),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return projects.get(where.id) ?? null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<ProjectRow> }) => {
          const row = projects.get(where.id);
          if (!row) throw new Error("not found");
          // A real write takes a moment: a read made outside its transaction
          // in that moment sees the old value (the #2436 audit race).
          await new Promise((resolve) => setTimeout(resolve, 5));
          const next = { ...row, ...data };
          projects.set(where.id, next);
          return next;
        },
      ),
    },
  });
  // One transaction at a time, as SQLite's single writer (and Postgres's row
  // lock on the project) serialise them.
  let queue: Promise<unknown> = Promise.resolve();
  (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(
    (fn: (tx: unknown) => Promise<unknown>) => {
      const run = queue.then(() => fn(prisma));
      queue = run.catch(() => undefined);
      return run;
    },
  );
  return { prisma, resolveDatabaseProvider: () => "sqlite" as const };
});

const auditSpy = vi.fn();
/** #2436 — the project-setting audit actions recorded (sign-ins are audited too). */
const projectAudits = () =>
  auditSpy.mock.calls
    .map((c) => (c[0] as { action: string }).action)
    .filter((a) => a.startsWith("project."));
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: (...args: unknown[]) => auditSpy(...args),
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { SELF_APPROVAL_FORBIDDEN_MESSAGE } from "../src/lib/requirements/requirement-version-service.js";
import { CHECKPOINT_HELD_REASON } from "../src/lib/analysis/checkpoint-authorship.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  projects.clear();
  projects.set("proj_gate_001", {
    id: "proj_gate_001",
    requireApprovedReview: false,
    allowSelfApproval: false,
  });
  app = createApp();
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/projects/:id/review-gate", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/projects/proj_gate_001/review-gate");
    expect(res.status).toBe(401);
  });

  it("returns the flag (default false) for any role with project.read", async () => {
    const token = await login("reader");
    const res = await request(app)
      .get("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requireApprovedReview: false, allowSelfApproval: false });
  });

  it("404s for an unknown project", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/projects/proj_missing/review-gate")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("PATCH /api/projects/:id/review-gate", () => {
  it("admin can enable the gate; the change is audited", async () => {
    const token = await login("admin");
    const res = await request(app)
      .patch("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requireApprovedReview: true, allowSelfApproval: false });
    expect(projects.get("proj_gate_001")?.requireApprovedReview).toBe(true);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.reviewGate.update",
        target: { type: "project", id: "proj_gate_001" },
        metadata: { requireApprovedReview: true },
      }),
    );
    // #2436 — the other setting was not sent, so it is neither written nor audited.
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "proj_gate_001" },
      data: { requireApprovedReview: true },
    });
    expect(projectAudits()).toHaveLength(1);
  });

  it("admin can disable the gate again", async () => {
    projects.set("proj_gate_001", {
      id: "proj_gate_001",
      requireApprovedReview: true,
      allowSelfApproval: false,
    });
    const token = await login("admin");
    const res = await request(app)
      .patch("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requireApprovedReview: false, allowSelfApproval: false });
  });

  it("developer (no review.admin) is rejected with 403 and the flag is untouched", async () => {
    const token = await login("developer");
    const res = await request(app)
      .patch("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: true });
    expect(res.status).toBe(403);
    expect(projects.get("proj_gate_001")?.requireApprovedReview).toBe(false);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it("reader is rejected with 403", async () => {
    const token = await login("reader");
    const res = await request(app)
      .patch("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: true });
    expect(res.status).toBe(403);
  });

  it("rejects a non-boolean payload with 400 VALIDATION_ERROR", async () => {
    const token = await login("admin");
    const res = await request(app)
      .patch("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("404s for an unknown project", async () => {
    const token = await login("admin");
    const res = await request(app)
      .patch("/api/projects/proj_missing/review-gate")
      .set("Authorization", `Bearer ${token}`)
      .send({ requireApprovedReview: true });
    expect(res.status).toBe(404);
  });
});

describe("#2436 — allowSelfApproval on PATCH /api/projects/:id/review-gate", () => {
  const send = async (role: string, body: object) =>
    request(app)
      .patch("/api/projects/proj_gate_001/review-gate")
      .set("Authorization", `Bearer ${await login(role)}`)
      .send(body);

  it("an admin allows self-approval; the change is audited with its old and new value", async () => {
    const res = await send("admin", { allowSelfApproval: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requireApprovedReview: false, allowSelfApproval: true });
    expect(projects.get("proj_gate_001")?.allowSelfApproval).toBe(true);
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "proj_gate_001" },
      data: { allowSelfApproval: true },
    });
    expect(projectAudits()).toHaveLength(1);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.selfApproval.update",
        target: { type: "project", id: "proj_gate_001" },
        metadata: { from: false, to: true },
      }),
    );
  });

  it("turning it off again is audited too", async () => {
    projects.set("proj_gate_001", {
      id: "proj_gate_001",
      requireApprovedReview: true,
      allowSelfApproval: true,
    });
    const res = await send("admin", { allowSelfApproval: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requireApprovedReview: true, allowSelfApproval: false });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.selfApproval.update",
        metadata: { from: true, to: false },
      }),
    );
  });

  it("two toggles at once are audited as a chain: each from is the value the other left", async () => {
    const [first, second] = [await login("admin"), await login("admin")];
    const patch = (token: string, allowSelfApproval: boolean) =>
      request(app)
        .patch("/api/projects/proj_gate_001/review-gate")
        .set("Authorization", `Bearer ${token}`)
        .send({ allowSelfApproval });

    const results = await Promise.all([patch(first, true), patch(second, false)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);

    const changes = auditSpy.mock.calls
      .map((c) => c[0] as { action: string; metadata: { from: boolean; to: boolean } })
      .filter((e) => e.action === "project.selfApproval.update")
      .map((e) => e.metadata);
    expect(changes).toHaveLength(2);
    // Read outside the write's transaction, both would record `from: false`.
    expect(changes[0]!.from).toBe(false);
    expect(changes[1]!.from).toBe(changes[0]!.to);
    expect(projects.get("proj_gate_001")?.allowSelfApproval).toBe(changes[1]!.to);
  });

  it("both settings in one PATCH are written and audited separately", async () => {
    const res = await send("admin", { requireApprovedReview: true, allowSelfApproval: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requireApprovedReview: true, allowSelfApproval: true });
    expect(projectAudits()).toEqual(["project.reviewGate.update", "project.selfApproval.update"]);
  });

  it("a developer (no review.admin) cannot allow it, and nothing changes", async () => {
    const res = await send("developer", { allowSelfApproval: true });
    expect(res.status).toBe(403);
    expect(projects.get("proj_gate_001")?.allowSelfApproval).toBe(false);
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(projectAudits()).toEqual([]);
  });

  // #2453 — maker-checker binds a coordinator, so a coordinator may not switch it off for
  // their own project: only an admin changes the setting. The refusal is server-side and
  // audited, and a PATCH carrying both settings is refused whole.
  for (const to of [true, false]) {
    it(`a coordinator cannot set it to ${to}: 403, nothing written, the attempt audited`, async () => {
      projects.set("proj_gate_001", {
        id: "proj_gate_001",
        requireApprovedReview: false,
        allowSelfApproval: !to,
      });
      const res = await send("coordinator", { allowSelfApproval: to });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("SELF_APPROVAL_SETTING_ADMIN_ONLY");
      expect(res.body.error.message).toMatch(/only an admin/i);
      expect(projects.get("proj_gate_001")?.allowSelfApproval).toBe(!to);
      expect(prisma.project.update).not.toHaveBeenCalled();
      expect(projectAudits()).toEqual(["project.selfApproval.denied"]);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { id: "user_coordinator" },
          action: "project.selfApproval.denied",
          target: { type: "project", id: "proj_gate_001" },
          metadata: { to, role: "coordinator" },
        }),
      );
    });
  }

  it("a coordinator sending both settings is refused whole: the gate is not written either", async () => {
    const res = await send("coordinator", { requireApprovedReview: true, allowSelfApproval: true });
    expect(res.status).toBe(403);
    expect(projects.get("proj_gate_001")).toMatchObject({
      requireApprovedReview: false,
      allowSelfApproval: false,
    });
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(projectAudits()).toEqual(["project.selfApproval.denied"]);
  });

  it("a coordinator still changes the approval gate on its own", async () => {
    const res = await send("coordinator", { requireApprovedReview: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requireApprovedReview: true, allowSelfApproval: false });
    expect(projectAudits()).toEqual(["project.reviewGate.update"]);
  });

  it("an empty body, an unknown key or a non-boolean is a 400", async () => {
    for (const body of [{}, { allowSelfApprovals: true }, { allowSelfApproval: "yes" }]) {
      const res = await send("admin", body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});

describe("#2453 — the refusals name who can allow self-approval", () => {
  it("an admin, not a coordinator", () => {
    for (const message of [SELF_APPROVAL_FORBIDDEN_MESSAGE, CHECKPOINT_HELD_REASON]) {
      expect(message).toContain("An admin can allow self-approval");
      expect(message).not.toMatch(/coordinator/i);
    }
  });
});
