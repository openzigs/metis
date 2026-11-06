/**
 * #1830 (epic #1827) — an `analysis-grounding` code citation records the
 * code-graph version it was read from, and both read paths return it.
 *
 * Real SQLite built from the migration chain. One project holds two repo
 * connections, A and B, whose graphs BOTH contain `src/auth.ts` (A at commit
 * `aaaaaaa`, B at `bbbbbbb`). Requirement R-A's evidence finding came from the
 * code pass for repo A, R-B's from the pass for repo B; neither citation names
 * its repo, so only the pass's connector tells them apart.
 *
 * Seeded through the public seeding function, then read back through
 * `prismaAgentCitationDeps` (impact analysis) on a SECOND Prisma client, and
 * through the real traceability route (real auth, real project access): never
 * through the object the writer built. A `manual` and a `semantic` link that
 * were already stored are untouched by the writer.
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
// The BRD staleness nudge a new link fires is not what this test is about.
vi.mock("../src/lib/docs-gen/approved-requirements-staleness.js", () => ({
  noteRequirementCodeLinksChanged: vi.fn(),
}));

const { traceabilityRouter } = await import("../src/routes/traceability.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { seedRequirementCodeLinksFromFindings } =
  await import("../src/lib/traceability/seed-code-links-from-findings.js");
const { prismaAgentCitationDeps } = await import("../src/lib/impact-analysis/agent-seeder.js");

const PROJ = "proj-1830";
const AUTH = "src/auth.ts";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1830 — a code citation carries its repo's graph version through both read paths",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let reader: PrismaClient;
    let token = "";
    const graph: Record<"A" | "B", string> = { A: "", B: "" };
    const req: Record<"A" | "B", string> = { A: "", B: "" };
    const before = new Date();

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId", traceabilityRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (path: string) => request(app()).get(path).set("Authorization", `Bearer ${token}`);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1830-citation-version");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      reader = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-1830", username: "u-1830", displayName: "U", email: "u@example.test" },
      });
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, description: "", createdById: "u-1830" },
      });
      await db.analysis.create({ data: { id: "an-1830", projectId: PROJ, startedById: "u-1830" } });

      for (const key of ["A", "B"] as const) {
        const repo = await db.repoConnection.create({
          data: { id: `conn-${key}`, projectId: PROJ, label: `repo-${key}`, createdById: "u-1830" },
        });
        graph[key] = (
          await db.codeGraph.create({
            data: {
              projectId: PROJ,
              repoConnectionId: repo.id,
              commitSha: key === "A" ? "aaaaaaa" : "bbbbbbb",
            },
          })
        ).id;
        // The same file, the same function, in both repositories.
        await db.codeSymbol.create({
          data: {
            codeGraphId: graph[key],
            projectId: PROJ,
            kind: "function",
            name: "login",
            qualifiedName: `${AUTH}::login`,
            filePath: AUTH,
            startLine: 5,
            endLine: 20,
            language: "typescript",
            contentHash: `login-${key}`,
          },
        });
        const pass = await db.agentResult.create({
          data: { analysisId: "an-1830", agentKey: "code", connectorId: repo.id },
        });
        const finding = await db.finding.create({
          data: {
            agentResultId: pass.id,
            category: "rationale",
            title: `login in ${key}`,
            body: "Users log in.",
            confidence: 0.8,
            evidence: JSON.stringify({
              citations: [{ filePath: AUTH, startLine: 8, endLine: 12 }],
            }),
          },
        });
        req[key] = (
          await db.requirement.create({
            data: {
              projectId: PROJ,
              analysisId: "an-1830",
              title: `Log in (${key})`,
              body: "Users must log in.",
              labels: JSON.stringify([`finding:${finding.id}`]),
            },
          })
        ).id;
      }

      // Already stored for R-A: a person's link and a semantic mapper's link.
      for (const source of ["manual", "semantic"]) {
        await db.requirementCodeMapping.create({
          data: {
            requirementId: req.A,
            projectId: PROJ,
            filePath: `src/${source}.ts`,
            confidence: 0.9,
            source,
          },
        });
      }

      token = issueTokens({
        userId: "u-1830",
        username: "u-1830",
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;

      const summary = await seedRequirementCodeLinksFromFindings({
        analysisId: "an-1830",
        projectId: PROJ,
        requirementIds: [req.A, req.B],
      });
      expect(summary.linksCreated).toBe(2);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      await reader?.$disconnect();
      sqlite?.cleanup();
    });

    it("impact analysis reads each citation with its own repo's graph, commit and freshness", async () => {
      const deps = prismaAgentCitationDeps(reader);
      for (const key of ["A", "B"] as const) {
        const links = await deps.loadCitations(req[key], PROJ);
        expect(links).toHaveLength(1);
        expect(links[0]).toMatchObject({
          filePath: AUTH,
          source: "analysis-grounding",
          freshness: "fresh",
          commitSha: key === "A" ? "aaaaaaa" : "bbbbbbb",
        });
        expect(links[0].validatedAt).toBeInstanceOf(Date);
        expect(links[0].validatedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      }
      // Stored graph ids: R-A's row carries A's graph, never B's.
      const rows = await reader.requirementCodeMapping.findMany({
        where: { projectId: PROJ, source: "analysis-grounding" },
        select: {
          requirementId: true,
          codeGraphId: true,
          codeSymbol: { select: { codeGraphId: true } },
        },
      });
      const byReq = new Map(rows.map((r) => [r.requirementId, r]));
      expect(byReq.get(req.A)).toMatchObject({
        codeGraphId: graph.A,
        codeSymbol: { codeGraphId: graph.A },
      });
      expect(byReq.get(req.B)).toMatchObject({
        codeGraphId: graph.B,
        codeSymbol: { codeGraphId: graph.B },
      });
    });

    it("the traceability route returns the version fields on each direct code link", async () => {
      const res = await get(`/api/projects/${PROJ}/requirements/${req.A}/traceability`);
      expect(res.status).toBe(200);
      const direct = res.body.data.directCode as Array<Record<string, unknown>>;
      const agent = direct.find((d) => d.source === "analysis-grounding");
      expect(agent).toMatchObject({ filePath: AUTH, freshness: "fresh", commitSha: "aaaaaaa" });
      expect(Date.parse(String(agent!.validatedAt))).toBeGreaterThanOrEqual(before.getTime());

      const resB = await get(`/api/projects/${PROJ}/requirements/${req.B}/traceability`);
      expect(resB.body.data.directCode[0]).toMatchObject({
        freshness: "fresh",
        commitSha: "bbbbbbb",
      });
    });

    it("leaves manual and semantic links untouched: unverified, no graph, no stamp", async () => {
      const others = await reader.requirementCodeMapping.findMany({
        where: { requirementId: req.A, projectId: PROJ, source: { in: ["manual", "semantic"] } },
        orderBy: { source: "asc" },
      });
      expect(others).toHaveLength(2);
      for (const row of others) {
        expect(row).toMatchObject({
          filePath: `src/${row.source}.ts`,
          confidence: 0.9,
          codeGraphId: null,
          commitSha: null,
          freshness: "unverified",
          validatedAt: null,
        });
      }
      const res = await get(`/api/projects/${PROJ}/requirements/${req.A}/traceability`);
      const manual = (res.body.data.directCode as Array<Record<string, unknown>>).find(
        (d) => d.source === "manual",
      );
      expect(manual).toMatchObject({ freshness: "unverified", commitSha: null, validatedAt: null });
    });
  },
);
