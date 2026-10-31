/**
 * Issue #1612 — a requirement's functional / non-functional `kind`, end to end
 * on a REAL SQLite database built from the migration chain.
 *
 *   - `PATCH /api/analyses/:id/requirements/:reqId` writes `kind` (and the NFR
 *     category), and `GET /api/analyses/:id` — the snapshot the Requirements hub
 *     and the gap report read — returns it. A value outside the enum is a 400.
 *   - Re-runs delete and recreate the requirement set. An analyst's `kind` edit
 *     is a versioned edit by a person, so it is review work (#769): the re-run's
 *     replacement is withheld and the edited `kind` is still what GET returns.
 *     The control case (no edit) is replaced, so the test cannot pass by the
 *     re-run silently doing nothing.
 *
 * Nothing on the write or read path is mocked except the Prisma singleton
 * (pointed at the migrated file) and the audit sink.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { SynthesisOutput } from "@metis/shared";
import type { FlatFinding } from "../src/lib/analysis/synthesis.js";
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
    resolveDatabaseProvider: () => "sqlite" as const,
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { persistRequirements } = await import("../src/lib/analysis/analysis-service.js");
const { fallbackSynthesize } = await import("../src/lib/analysis/synthesis.js");

const PROJECT = "proj-1612";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1612 — requirement kind through the PATCH and GET routes",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let TOKEN = "";
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/analyses", initAnalysisRouter().topLevel);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const patch = (analysisId: string, reqId: string, body: Record<string, unknown>) =>
      request(app())
        .patch(`/api/analyses/${analysisId}/requirements/${reqId}`)
        .set("Authorization", `Bearer ${TOKEN}`)
        .send(body);
    const readBack = async (analysisId: string) => {
      const res = await request(app())
        .get(`/api/analyses/${analysisId}`)
        .set("Authorization", `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      return res.body.data.requirements as Array<{
        id: string;
        title: string;
        kind: string | null;
        nfrCategory: string | null;
      }>;
    };

    /** A fresh analysis whose requirement set came from a synthesis. */
    const analysisWithSet = async (synthesis: SynthesisOutput) => {
      seq += 1;
      const id = `ana-1612-${seq}`;
      await db.analysis.create({
        data: { id, projectId: PROJECT, startedById: "u-ba", status: "completed" },
      });
      const ids = await persistRequirements({
        analysisId: id,
        projectId: PROJECT,
        synthesis,
        findingIdsByIndex: [],
      });
      return { analysisId: id, ids };
    };
    const synthesis = (title: string, extra: Record<string, unknown> = {}): SynthesisOutput => ({
      summary: "s",
      requirements: [
        {
          type: "feature",
          title,
          body: `${title} body`,
          priority: "medium",
          labels: [],
          evidenceFindingIndexes: [],
          acceptanceCriteria: [],
          ...extra,
        },
      ],
    });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1612-requirement-kind");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-ba", username: "u-ba", displayName: "BA", email: "ba@example.test" },
      });
      await db.workspace.create({ data: { id: "ws-1612", name: "ws", slug: "ws-1612" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1612", userId: "u-ba", role: "member" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: "u-ba",
          workspaceId: "ws-1612",
        },
      });
      TOKEN = issueTokens({
        userId: "u-ba",
        username: "u-ba",
        role: "coordinator",
        permissions: [],
        workspaces: ["ws-1612"],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a synthesis that names no kind persists NULL (unknown), never a default", async () => {
      const { analysisId } = await analysisWithSet(synthesis("Export orders"));
      const [req] = await readBack(analysisId);
      expect(req).toMatchObject({ kind: null, nfrCategory: null });
    });

    it("the deterministic fallback's requirements are stored with kind NULL (#1117)", async () => {
      const fallback = fallbackSynthesize([
        {
          agentKey: "code",
          category: "performance",
          severity: "high",
          title: "Checkout p95 is 2.4 s",
          body: "No caching on checkout.",
          tags: ["perf"],
          citations: [],
        },
      ] as FlatFinding[]);
      const { analysisId } = await analysisWithSet(fallback);
      const reqs = await readBack(analysisId);
      expect(reqs.length).toBeGreaterThan(0);
      for (const r of reqs) expect(r).toMatchObject({ kind: null, nfrCategory: null });
    });

    it("a synthesis kind and category are stored and read back", async () => {
      const { analysisId } = await analysisWithSet(
        synthesis("Checkout answers in 200 ms", {
          kind: "non-functional",
          nfrCategory: "performance",
        }),
      );
      const [req] = await readBack(analysisId);
      expect(req).toMatchObject({ kind: "non-functional", nfrCategory: "performance" });
    });

    it("PATCH writes kind + category; GET (the list the UI reads) returns them; the edit is versioned", async () => {
      const { analysisId, ids } = await analysisWithSet(synthesis("Lock accounts"));
      const res = await patch(analysisId, ids[0]!, {
        kind: "non-functional",
        nfrCategory: "security",
      });
      expect(res.status).toBe(200);

      const [req] = await readBack(analysisId);
      expect(req).toMatchObject({ id: ids[0], kind: "non-functional", nfrCategory: "security" });
      const history = await db.requirementVersion.findMany({ where: { requirementId: ids[0] } });
      expect(history).toHaveLength(1);
      expect(history[0]!.actorId).toBe("u-ba");
      expect(JSON.parse(history[0]!.changedFields)).toEqual({
        kind: { from: null, to: "non-functional" },
        nfrCategory: { from: null, to: "security" },
      });
    });

    it("a stale-version PATCH of kind is a 409 whose diff names the kind", async () => {
      const { analysisId, ids } = await analysisWithSet(synthesis("Session timeout"));
      expect((await patch(analysisId, ids[0]!, { kind: "functional" })).status).toBe(200);

      const stale = await patch(analysisId, ids[0]!, { kind: "non-functional", version: 0 });

      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe("VERSION_CONFLICT");
      expect(stale.body.error.diff).toContainEqual({
        field: "kind",
        server: "functional",
        client: "non-functional",
      });
    });

    it("changing kind to functional clears the category; null clears kind", async () => {
      const { analysisId, ids } = await analysisWithSet(
        synthesis("Uptime", { kind: "non-functional", nfrCategory: "availability" }),
      );
      expect((await patch(analysisId, ids[0]!, { kind: "functional" })).status).toBe(200);
      expect((await readBack(analysisId))[0]).toMatchObject({
        kind: "functional",
        nfrCategory: null,
      });
      // Cleared in the row itself, not just hidden by the read.
      const stored = await db.requirement.findUniqueOrThrow({ where: { id: ids[0] } });
      expect(stored).toMatchObject({ kind: "functional", nfrCategory: null });
      expect((await patch(analysisId, ids[0]!, { kind: null })).status).toBe(200);
      expect((await readBack(analysisId))[0]).toMatchObject({ kind: null, nfrCategory: null });
    });

    it.each([
      ["a kind outside the enum", { kind: "quality" }],
      ["a category outside the enum", { kind: "non-functional", nfrCategory: "speed" }],
      ["a category without kind: non-functional", { nfrCategory: "performance" }],
      ["a category on a functional requirement", { kind: "functional", nfrCategory: "security" }],
    ])("rejects %s with 400 and writes nothing", async (_name, body) => {
      const { analysisId, ids } = await analysisWithSet(synthesis("Search"));
      const res = await patch(analysisId, ids[0]!, body);
      expect(res.status).toBe(400);
      expect((await readBack(analysisId))[0]).toMatchObject({ kind: null, nfrCategory: null });
      expect(await db.requirementVersion.count({ where: { requirementId: ids[0] } })).toBe(0);
    });

    it("a re-run keeps an analyst-edited kind: the edit is review work, so the replacement is withheld", async () => {
      const { analysisId, ids } = await analysisWithSet(synthesis("Audit logins"));
      expect(
        (await patch(analysisId, ids[0]!, { kind: "non-functional", nfrCategory: "compliance" }))
          .status,
      ).toBe(200);

      let withheld = false;
      await persistRequirements({
        analysisId,
        projectId: PROJECT,
        synthesis: synthesis("Audit logins (re-run)", { kind: "functional" }),
        findingIdsByIndex: [],
        onWithheld: () => {
          withheld = true;
        },
      });

      expect(withheld).toBe(true);
      // The refused result is stored for the analyst to compare (#780), kind
      // included: the proposal is a second writer of the classification.
      const stored = await db.analysis.findUniqueOrThrow({
        where: { id: analysisId },
        select: { metadata: true },
      });
      const proposal = JSON.parse(stored.metadata ?? "{}").withheldReplacementProposal as {
        rows: Array<{ title: string; kind: string | null }>;
      };
      expect(proposal.rows).toHaveLength(1);
      expect(proposal.rows[0]).toMatchObject({
        title: "Audit logins (re-run)",
        kind: "functional",
      });
      const after = await readBack(analysisId);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        id: ids[0],
        title: "Audit logins",
        kind: "non-functional",
        nfrCategory: "compliance",
      });
    });

    it("control: a re-run over an UNEDITED set replaces it, kind and all", async () => {
      const { analysisId } = await analysisWithSet(synthesis("Rate limit", { kind: "functional" }));
      let withheld = false;
      await persistRequirements({
        analysisId,
        projectId: PROJECT,
        synthesis: synthesis("Rate limit (re-run)", {
          kind: "non-functional",
          nfrCategory: "security",
        }),
        findingIdsByIndex: [],
        onWithheld: () => {
          withheld = true;
        },
      });
      expect(withheld).toBe(false);
      const [req] = await readBack(analysisId);
      expect(req).toMatchObject({
        title: "Rate limit (re-run)",
        kind: "non-functional",
        nfrCategory: "security",
      });
    });
  },
);
