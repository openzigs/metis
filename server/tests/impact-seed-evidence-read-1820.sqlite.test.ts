/**
 * #1820 — the stored seed evidence (#1754) reaches the impact page through the
 * real read path: `GET /api/impact-analyses/:id` on the real router, real auth
 * and project-access check, real `getImpactAnalysisDetail`, against a real SQLite
 * database built by the migration chain.
 *
 * The Playwright journey for #1762 serves the whole detail through
 * `page.route`, and the read unit tests call `seedEvidenceOf` on a string, so a
 * read route that dropped `seedEvidence` (from the include, the item view or the
 * response) left every test green. The column is written here exactly as the
 * engine writes it: `JSON.stringify(impactSeedEvidenceSchema.parse(evidence))`.
 */
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
  // The route limiters read their caps at module load.
  process.env.RATE_LIMIT_MAX = "100000";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import express from "express";
import request from "supertest";
import {
  getPermissionsForRole,
  impactSeedEvidenceSchema,
  type ImpactAnalysisDetail,
  type ImpactSeedEvidence,
} from "@metis/shared";

const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const USER = "u-1820";
const PROJ = "p-1820";
const RUN = "ia-1820";

const EVIDENCE: ImpactSeedEvidence = {
  storedLinks: { used: 1, stale: 1 },
  verifier: { promoted: 1, doubtful: 1, droppedPromotions: 0 },
  agentCitations: { used: 1, stale: 0, led: 1 },
  editCandidates: [
    { filePath: "src/orders/notify-repo.ts", channels: ["code-agent"] },
    {
      filePath: "src/mail/mailer.ts",
      channels: ["edit-verifier"],
      baseScore: 0.4,
      verdict: {
        kind: "promoted",
        reason: "Sends the receipt email when an order is paid",
        line: 11,
        verified: true,
      },
    },
    {
      filePath: "src/orders/orders.ts",
      channels: ["hybrid", "stored-link"],
      baseScore: 1,
      verdict: { kind: "doubtful", reason: "Lists orders; sends nothing" },
    },
  ],
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1820 — seed evidence on GET /api/impact-analyses/:id (real router, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let token: string;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1820-impact-seed-evidence-read");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      await db.workspace.create({ data: { id: "ws-1820", name: "ws", slug: "ws-1820" } });
      await db.workspaceMember.create({ data: { workspaceId: "ws-1820", userId: USER } });
      await db.project.create({
        data: { id: PROJ, name: "Shop", slug: PROJ, createdById: USER, workspaceId: "ws-1820" },
      });
      await db.impactAnalysis.create({
        data: {
          id: RUN,
          status: "completed",
          sourceText: "Send a receipt when an order is paid",
          startedById: USER,
          projects: { create: [{ projectId: PROJ }] },
        },
      });
      const withEvidence = await db.impactItem.create({
        data: {
          impactAnalysisId: RUN,
          projectId: PROJ,
          requirementTitle: "Send a receipt",
          // The engine's own serialisation (impact-analysis-engine.ts).
          seedEvidence: JSON.stringify(impactSeedEvidenceSchema.parse(EVIDENCE)),
        },
      });
      await db.impactAffectedSymbol.create({
        data: {
          impactItemId: withEvidence.id,
          filePath: "src/orders/orders.ts",
          qualifiedName: "src/orders/orders.ts::listOrders",
        },
      });
      // A run with the seed channels off writes no evidence: the view has no key.
      await db.impactItem.create({
        data: { impactAnalysisId: RUN, projectId: PROJ, requirementTitle: "No evidence" },
      });

      token = issueTokens({
        userId: USER,
        username: USER,
        role: "developer",
        permissions: getPermissionsForRole("developer"),
        workspaces: ["ws-1820"],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("returns each item's stored seed evidence, and no key where none was stored", async () => {
      const res = await request(app())
        .get(`/api/impact-analyses/${RUN}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const detail = res.body.data as ImpactAnalysisDetail;
      const byTitle = new Map(detail.items.map((i) => [i.requirementTitle, i]));

      expect(byTitle.get("Send a receipt")?.seedEvidence).toEqual(EVIDENCE);
      expect(byTitle.get("No evidence")).toBeDefined();
      expect(byTitle.get("No evidence")).not.toHaveProperty("seedEvidence");
    });
  },
);
