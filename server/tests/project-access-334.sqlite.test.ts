/**
 * #334 — by-id routes mounted OUTSIDE `/api/projects` that act on a
 * project-scoped row: `GET /api/baselines/:baselineId`,
 * `GET /api/baselines/:idA/compare/:idB` and
 * `POST /api/findings/:id/review-ack`. Each one loaded its row by id and was
 * gated by a role permission alone, so a caller in another workspace could read
 * a baseline's pinned requirement snapshots or acknowledge a finding.
 *
 * Proven through the REAL routers, the REAL `requirePermission` and the REAL
 * `assertProjectAccess`, against a REAL SQLite database built from the
 * migration chain. Two workspaces: `ws-a` (project `proj-a-0334`) and `ws-b`
 * (project `proj-b-0334`). The attacker is `u-b`, a coordinator in `ws-b` — a
 * role that holds `review.read` and `project.read`, so every refusal below is
 * the project check, never the role check. Each refusal asserts the 404 is
 * byte-identical to an unknown id's. Positive controls: the same-workspace
 * coordinator `u-a` and a system admin, so a check that refuses everyone
 * cannot pass.
 *
 * The run-review routes are proven in `project-access-334-run-reviews.sqlite.test.ts`:
 * their permissions are admin-only today, so that file has to widen the ROLE
 * gate to reach the project check at all.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditSpy }));

const { baselinesRouter } = await import("../src/routes/baselines.js");
const { findingsRouter } = await import("../src/routes/findings.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

type Role = "admin" | "coordinator" | "developer" | "reader";

const PA = "proj-a-0334";
const PB = "proj-b-0334";
const PLEGACY = "proj-legacy-0334";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#334 — by-id baseline and finding routes check the caller's access to the row's project",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const token = (userId: string, role: Role, workspaces: string[]) =>
      issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
    let ADMIN = "";
    let A = ""; // coordinator in ws-a — same-workspace positive control
    let B = ""; // coordinator in ws-b — the attacker
    let READER_A = ""; // reader in ws-a — lowest role holding both permissions

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/baselines", baselinesRouter());
      a.use("/api/findings", findingsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (url: string, bearer: string) =>
      request(app()).get(url).set("Authorization", `Bearer ${bearer}`);
    const post = (url: string, bearer: string, body: Record<string, unknown> = {}) =>
      request(app()).post(url).set("Authorization", `Bearer ${bearer}`).send(body);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("334-byid-project-access");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      for (const id of ["u-admin", "u-a", "u-b", "u-ra"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of ["ws-a", "ws-b"]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [ws, userId] of [
        ["ws-a", "u-a"],
        ["ws-a", "u-ra"],
        ["ws-b", "u-b"],
      ]) {
        await db.workspaceMember.create({ data: { workspaceId: ws, userId, role: "member" } });
      }
      for (const [id, ws] of [
        [PA, "ws-a"],
        [PB, "ws-b"],
        [PLEGACY, null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-admin", workspaceId: ws },
        });
      }

      // Requirements + baselines: two in project A (so A can compare its own),
      // one in project B (the attacker's own, for the mixed compare).
      for (const [pid, suffix] of [
        [PA, "a"],
        [PB, "b"],
      ]) {
        await db.analysis.create({
          data: { id: `an-${suffix}`, projectId: pid, startedById: "u-admin" },
        });
        await db.requirement.create({
          data: {
            id: `req-${suffix}`,
            projectId: pid,
            analysisId: `an-${suffix}`,
            title: `secret title ${suffix}`,
            body: `secret body ${suffix}`,
          },
        });
      }
      for (const [id, pid, req] of [
        ["bl-a1", PA, "req-a"],
        ["bl-a2", PA, "req-a"],
        ["bl-b1", PB, "req-b"],
      ]) {
        await db.baseline.create({
          data: {
            id,
            projectId: pid,
            name: id,
            createdById: "u-admin",
            items: { create: [{ requirementId: req, version: 1 }] },
          },
        });
      }

      // Findings: one reached through an analysis agent result, one
      // materialised from a scan finding (no agent result) — the two
      // provenance paths a finding's project is resolved through.
      await db.agentResult.create({
        data: { id: "ar-a", analysisId: "an-a", agentKey: "security-scanner" },
      });
      await db.finding.create({
        data: {
          id: "fnd-agent-a",
          agentResultId: "ar-a",
          category: "security",
          title: "t",
          body: "b",
          derivation: "ambiguous",
          confidence: 0.4,
        },
      });
      await db.repoConnection.create({ data: { id: "rc-a", projectId: PA, label: "repo-a" } });
      await db.codeGraph.create({ data: { id: "cg-a", projectId: PA } });
      await db.codeSymbol.create({
        data: {
          id: "sym-a",
          codeGraphId: "cg-a",
          projectId: PA,
          kind: "function",
          name: "f",
          qualifiedName: "a.ts::f",
          filePath: "a.ts",
          startLine: 1,
          endLine: 2,
          language: "ts",
          contentHash: "h",
        },
      });
      await db.scan.create({
        data: {
          id: "scan-a",
          projectId: PA,
          repoConnectionId: "rc-a",
          commitSha: "0".repeat(40),
          createdById: "u-admin",
        },
      });
      await db.scanFinding.create({
        data: {
          id: "sf-a",
          scanId: "scan-a",
          symbolId: "sym-a",
          fingerprint: "fp",
          title: "t",
          body: "b",
        },
      });
      await db.finding.create({
        data: {
          id: "fnd-scan-a",
          scanFindingId: "sf-a",
          category: "security",
          title: "t",
          body: "b",
          derivation: "extracted",
          confidence: 1,
        },
      });
      // A finding on a legacy (no-workspace) project stays reachable, exactly as
      // `assertProjectAccess` keeps legacy projects open until the backfill.
      await db.analysis.create({
        data: { id: "an-legacy", projectId: PLEGACY, startedById: "u-admin" },
      });
      await db.agentResult.create({
        data: { id: "ar-legacy", analysisId: "an-legacy", agentKey: "security-scanner" },
      });
      await db.finding.create({
        data: {
          id: "fnd-legacy",
          agentResultId: "ar-legacy",
          category: "x",
          title: "t",
          body: "b",
        },
      });
      // A finding with neither provenance link resolves to no project: it is
      // unreachable to a non-admin (fail closed, never widened).
      await db.finding.create({
        data: { id: "fnd-orphan", category: "x", title: "t", body: "b" },
      });

      ADMIN = token("u-admin", "admin", []);
      A = token("u-a", "coordinator", ["ws-a"]);
      B = token("u-b", "coordinator", ["ws-b"]);
      READER_A = token("u-ra", "reader", ["ws-a"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => auditSpy.mockClear());

    // ── GET /api/baselines/:baselineId ─────────────────────────────────────
    describe("GET /api/baselines/:baselineId", () => {
      it("a cross-workspace coordinator gets the unknown-id 404 and no snapshot", async () => {
        const res = await get("/api/baselines/bl-a1", B);
        const unknown = await get("/api/baselines/bl-does-not-exist", B);
        expect(res.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(res.body).toEqual(unknown.body);
        expect(JSON.stringify(res.body)).not.toContain("secret");
      });

      it("the same-workspace coordinator, reader and a system admin read it", async () => {
        for (const who of [A, READER_A, ADMIN]) {
          const res = await get("/api/baselines/bl-a1", who);
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(res.body.data.baseline.id).toBe("bl-a1");
        }
      });

      it("the attacker still reads a baseline in their own project", async () => {
        const res = await get("/api/baselines/bl-b1", B);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      });
    });

    // ── GET /api/baselines/:idA/compare/:idB ───────────────────────────────
    describe("GET /api/baselines/:idA/compare/:idB", () => {
      it("both ids foreign: the unknown-id 404", async () => {
        const res = await get("/api/baselines/bl-a1/compare/bl-a2", B);
        const unknown = await get("/api/baselines/bl-nope-1/compare/bl-nope-2", B);
        expect(res.status).toBe(404);
        expect(res.body).toEqual(unknown.body);
        expect(JSON.stringify(res.body)).not.toContain("secret");
      });

      it("idA own, idB foreign: the unknown-id 404, never the project-mismatch 400", async () => {
        const res = await get("/api/baselines/bl-b1/compare/bl-a1", B);
        const unknown = await get("/api/baselines/bl-b1/compare/bl-nope", B);
        expect(res.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(res.body).toEqual(unknown.body);
      });

      it("idA foreign, idB own: the unknown-id 404", async () => {
        const res = await get("/api/baselines/bl-a1/compare/bl-b1", B);
        const unknown = await get("/api/baselines/bl-nope/compare/bl-b1", B);
        expect(res.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(res.body).toEqual(unknown.body);
      });

      it("the same-workspace coordinator and a system admin compare the pair", async () => {
        for (const who of [A, ADMIN]) {
          const res = await get("/api/baselines/bl-a1/compare/bl-a2", who);
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(res.body.data.baselineA.id).toBe("bl-a1");
        }
      });

      it("an admin comparing across projects still gets the designed mismatch 400", async () => {
        const res = await get("/api/baselines/bl-a1/compare/bl-b1", ADMIN);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("BASELINE_PROJECT_MISMATCH");
      });
    });

    // ── POST /api/findings/:id/review-ack ──────────────────────────────────
    describe("POST /api/findings/:id/review-ack", () => {
      it.each(["fnd-agent-a", "fnd-scan-a"])(
        "%s: a cross-workspace coordinator gets the unknown-id 404 and nothing is audited",
        async (id) => {
          const res = await post(`/api/findings/${id}/review-ack`, B, { note: "x" });
          const unknown = await post("/api/findings/fnd-nope/review-ack", B, { note: "x" });
          expect(res.status).toBe(404);
          expect(unknown.status).toBe(404);
          expect(res.body).toEqual(unknown.body);
          expect(auditSpy).not.toHaveBeenCalled();
        },
      );

      it.each(["fnd-agent-a", "fnd-scan-a"])(
        "%s: the same-workspace reader and a system admin acknowledge it (audited)",
        async (id) => {
          for (const who of [READER_A, ADMIN]) {
            auditSpy.mockClear();
            const res = await post(`/api/findings/${id}/review-ack`, who, { note: "ok" });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.data.id).toBe(id);
            expect(auditSpy).toHaveBeenCalledTimes(1);
          }
        },
      );

      it("a finding on a legacy no-workspace project stays reachable (as assertProjectAccess rules)", async () => {
        const res = await post("/api/findings/fnd-legacy/review-ack", B);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      });

      it("a finding with no resolvable project is admin-only (fail closed)", async () => {
        const refused = await post("/api/findings/fnd-orphan/review-ack", A);
        const unknown = await post("/api/findings/fnd-nope/review-ack", A);
        expect(refused.status).toBe(404);
        expect(refused.body).toEqual(unknown.body);
        expect((await post("/api/findings/fnd-orphan/review-ack", ADMIN)).status).toBe(200);
      });
    });
  },
);
