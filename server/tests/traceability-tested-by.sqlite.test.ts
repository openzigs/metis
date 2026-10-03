/**
 * #814 — "Tested by" walkthrough fixture on a REAL SQLite database built from
 * the migration chain, driven through the REAL traceability router (real auth,
 * real `requireProjectAccess`, real Prisma queries).
 *
 * Mirrors miniflux/v2 `v2.3.3`: `internal/validator/user.go` and its sibling
 * `user_test.go`, a file-only `analysis-grounding` mapping (the shape
 * `seed-code-links-from-findings.ts` writes), an OIDC requirement mapped to a
 * file with no test, and one requirement with no mapping at all. A second
 * project holds the SAME file paths, so any missing `projectId` filter shows
 * up as a leaked test.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { traceabilityRouter } = await import("../src/routes/traceability.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const PROJ = "proj-miniflux-814";
const OTHER = "proj-other-814";
const USER_GO = "internal/validator/user.go";
const USER_TEST = "internal/validator/user_test.go";
const OIDC_GO = "internal/oauth2/oidc.go";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#814 — Tested by on the miniflux walkthrough fixture (real router, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let token = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId", traceabilityRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (path: string) => request(app()).get(path).set("Authorization", `Bearer ${token}`);

    async function symbol(
      projectId: string,
      graphId: string,
      filePath: string,
      name: string,
      startLine: number,
    ): Promise<string> {
      const row = await db.codeSymbol.create({
        data: {
          codeGraphId: graphId,
          projectId,
          kind: "function",
          name,
          qualifiedName: `${filePath}::${name}`,
          filePath,
          startLine,
          endLine: startLine + 10,
          language: "go",
          contentHash: `${projectId}-${name}`,
        },
      });
      return row.id;
    }

    const ids = { pw: "", oidc: "", none: "", testPw: "", validatePw: "", otherTest: "" };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("814-tested-by");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-admin", username: "u-admin", displayName: "A", email: "a@example.test" },
      });
      for (const id of [PROJ, OTHER]) {
        await db.project.create({
          data: { id, name: id, slug: id, description: "", createdById: "u-admin" },
        });
        await db.analysis.create({
          data: { id: `an-${id}`, projectId: id, startedById: "u-admin" },
        });
        await db.codeGraph.create({ data: { id: `g-${id}`, projectId: id } });
      }

      const g = `g-${PROJ}`;
      ids.validatePw = await symbol(PROJ, g, USER_GO, "validatePassword", 20);
      await symbol(PROJ, g, USER_GO, "validateUsername", 40);
      ids.testPw = await symbol(PROJ, g, USER_TEST, "TestValidatePassword", 55);
      await symbol(PROJ, g, USER_TEST, "TestValidateUsername", 90);
      await symbol(PROJ, g, OIDC_GO, "mapRoles", 12);

      // Project B: the same paths, its own test and an edge into project A's symbol id.
      const gb = `g-${OTHER}`;
      await symbol(OTHER, gb, USER_GO, "validatePassword", 20);
      ids.otherTest = await symbol(OTHER, gb, "internal/oauth2/oidc_test.go", "TestMapRoles", 5);
      await db.codeEdge.create({
        data: {
          codeGraphId: gb,
          projectId: OTHER,
          kind: "calls",
          fromSymbolId: ids.otherTest,
          toSymbolId: ids.validatePw,
          filePath: "internal/oauth2/oidc_test.go",
          line: 6,
        },
      });

      const requirement = async (title: string, body: string) =>
        (
          await db.requirement.create({
            data: { projectId: PROJ, analysisId: `an-${PROJ}`, title, body },
          })
        ).id;
      ids.pw = await requirement(
        "Password must be at least 6 characters",
        "Reject passwords shorter than six characters at registration.",
      );
      ids.oidc = await requirement("OIDC role mapping", "Map OIDC claims to roles.");
      ids.none = await requirement("Export settings", "No code yet.");
      const deleted = await requirement("Deleted requirement", "gone");
      await db.requirement.update({ where: { id: deleted }, data: { deletedAt: new Date() } });

      const fileOnly = (requirementId: string, filePath: string) =>
        db.requirementCodeMapping.create({
          data: {
            requirementId,
            projectId: PROJ,
            codeSymbolId: null,
            filePath,
            startLine: null,
            endLine: null,
            source: "analysis-grounding",
          },
        });
      await fileOnly(ids.pw, USER_GO);
      await fileOnly(ids.oidc, OIDC_GO);
      await fileOnly(deleted, OIDC_GO);

      token = issueTokens({
        userId: "u-admin",
        username: "u-admin",
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("links the password requirement to TestValidatePassword by naming, above TestValidateUsername", async () => {
      const res = await get(`/api/projects/${PROJ}/requirements/${ids.pw}/traceability`);
      expect(res.status).toBe(200);
      const testedBy = res.body.data.testedBy;
      expect(testedBy[0]).toMatchObject({
        filePath: USER_TEST,
        name: "TestValidatePassword",
        startLine: 55,
        relation: "naming",
        convention: "go-testing",
        subject: { filePath: USER_GO, symbol: `${USER_GO}::validatePassword` },
      });
      expect(testedBy.map((t: { name: string }) => t.name)).toEqual([
        "TestValidatePassword",
        "TestValidateUsername",
      ]);
      expect(testedBy[0].score).toBeGreaterThan(testedBy[1].score);
      // Project B's test, though it has an edge into this project's symbol id, never appears.
      expect(JSON.stringify(testedBy)).not.toContain("TestMapRoles");
      expect(res.body.data.directCode[0]).toMatchObject({ filePath: USER_GO, isTest: false });
    });

    it("test-gaps lists OIDC as no-test, counts the unmapped requirement, omits the tested one", async () => {
      const res = await get(`/api/projects/${PROJ}/traceability/test-gaps?analysisId=an-${PROJ}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        total: 3,
        tested: 1,
        noCode: 1,
        untested: [
          {
            requirementId: ids.oidc,
            title: "OIDC role mapping",
            analysisId: `an-${PROJ}`,
            reason: "no-test",
            mappedFiles: 1,
          },
        ],
        nextCursor: null,
      });
    });

    it("404s another project's analysisId", async () => {
      const res = await get(`/api/projects/${PROJ}/traceability/test-gaps?analysisId=an-${OTHER}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
    });

    it("returns relation exercises once a calls edge TestValidatePassword → validatePassword exists", async () => {
      await db.codeEdge.create({
        data: {
          codeGraphId: `g-${PROJ}`,
          projectId: PROJ,
          kind: "calls",
          fromSymbolId: ids.testPw,
          toSymbolId: ids.validatePw,
          filePath: USER_TEST,
          line: 57,
        },
      });
      const res = await get(`/api/projects/${PROJ}/requirements/${ids.pw}/traceability`);
      expect(res.status).toBe(200);
      expect(res.body.data.testedBy[0]).toMatchObject({
        name: "TestValidatePassword",
        relation: "exercises",
      });
      expect(
        res.body.data.testedBy.filter((t: { name: string }) => t.name === "TestValidatePassword"),
      ).toHaveLength(1);
    });
  },
);
