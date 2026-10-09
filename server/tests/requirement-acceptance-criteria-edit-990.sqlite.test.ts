/**
 * #990 — a requirement's acceptance criteria could not be edited: the Edit
 * dialog's `PUT /api/requirements/:id` accepted no `acceptanceCriteria`, so the
 * generated list was the one every issue draft carried.
 *
 * The criteria are now an editable, versioned field: the PUT replaces the list,
 * a real change bumps `version` and appends a `RequirementVersion` row (and a
 * restore brings an earlier list back), and the issue draft renders the edited
 * list. Proven through the real router, version service and draft generator
 * against a real SQLite database built from the migration chain.
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
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { parseAcceptanceCriteria } = await import("@metis/shared");
const { generateDrafts } = await import("../src/lib/publishing/draft-generator.js");
const { getAnalysisSnapshot } = await import("../src/lib/analysis/analysis-service.js");
const { createManualBaseline, compareBaselines } =
  await import("../src/lib/reviews/baseline-service.js");

const PROJECT = "proj-990";
const USER = "u-990";
const GENERATED = ["The generated criterion one", "The generated criterion two"];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#990 — acceptance criteria are editable, versioned and drive the issue draft",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let TOKEN = "";
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const put = (id: string, body: Record<string, unknown>) =>
      request(app())
        .put(`/api/requirements/${id}`)
        .set("Authorization", `Bearer ${TOKEN}`)
        .send(body);

    const makeRequirement = async (opts: { body?: string; criteria?: string[] } = {}) => {
      seq += 1;
      const analysis = await db.analysis.create({
        data: { projectId: PROJECT, startedById: USER, status: "completed" },
      });
      const row = await db.requirement.create({
        data: {
          id: `req-990-${seq}`,
          projectId: PROJECT,
          analysisId: analysis.id,
          title: `Feeds refresh on a schedule ${seq}`,
          body: opts.body ?? "Feeds are refreshed periodically.",
          version: 1,
          acceptanceCriteria: JSON.stringify(opts.criteria ?? GENERATED),
        },
      });
      return { id: row.id, analysisId: analysis.id };
    };
    const stored = async (id: string) =>
      db.requirement.findUniqueOrThrow({
        where: { id },
        select: { acceptanceCriteria: true, version: true },
      });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("990-acceptance-criteria-edit");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.workspace.create({ data: { id: "ws-990", name: "ws", slug: "ws-990" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-990", userId: USER, role: "owner" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: USER,
          workspaceId: "ws-990",
        },
      });
      TOKEN = issueTokens({
        userId: USER,
        username: USER,
        role: "admin",
        permissions: [],
        workspaces: ["ws-990"],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("replaces the list, trims it, and records a new version with the change", async () => {
      const { id } = await makeRequirement();

      const res = await put(id, {
        version: 1,
        acceptanceCriteria: [
          "  A feed refreshes every 60 minutes  ",
          "A failed refresh is retried",
        ],
      });

      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(2);
      const row = await stored(id);
      expect(JSON.parse(row.acceptanceCriteria)).toEqual([
        "A feed refreshes every 60 minutes",
        "A failed refresh is retried",
      ]);
      const versions = await db.requirementVersion.findMany({ where: { requirementId: id } });
      expect(versions).toHaveLength(1);
      const changed = JSON.parse(versions[0]!.changedFields) as Record<
        string,
        { from: string; to: string }
      >;
      expect(Object.keys(changed)).toEqual(["acceptanceCriteria"]);
      expect(JSON.parse(changed.acceptanceCriteria!.from)).toEqual(GENERATED);
    });

    it("the same list is a no-op: no new version", async () => {
      const { id } = await makeRequirement();

      const res = await put(id, { version: 1, acceptanceCriteria: GENERATED });

      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(1);
      expect(await db.requirementVersion.count({ where: { requirementId: id } })).toBe(0);
    });

    it("restoring the earlier version brings the earlier list back", async () => {
      const { id } = await makeRequirement();
      await put(id, { version: 1, acceptanceCriteria: ["Edited criterion"] });
      await put(id, { version: 2, acceptanceCriteria: ["Edited again"] });

      // The history reconstructs each version's list from the diffs.
      const history = await request(app())
        .get(`/api/requirements/${id}/history`)
        .set("Authorization", `Bearer ${TOKEN}`);
      expect(history.status).toBe(200);
      const entries = history.body.data.versions as Array<{
        version: number;
        snapshot: Record<string, unknown>;
      }>;
      const v2 = entries.find((e) => e.version === 2);
      expect(JSON.parse(String(v2?.snapshot.acceptanceCriteria))).toEqual(["Edited criterion"]);
      // The current version's snapshot is read from the row itself, so it
      // carries the criteria only if the history route selects the column.
      const current = entries.find((e) => e.version === 3);
      expect(current).toBeDefined();
      expect(JSON.parse(String(current?.snapshot.acceptanceCriteria))).toEqual(["Edited again"]);

      const res = await request(app())
        .post(`/api/requirements/${id}/restore/2`)
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({});

      expect(res.status).toBe(200);
      expect(JSON.parse((await stored(id)).acceptanceCriteria)).toEqual(["Edited criterion"]);
    });

    it("an empty list clears the criteria", async () => {
      const { id } = await makeRequirement();

      const res = await put(id, { version: 1, acceptanceCriteria: [] });

      expect(res.status).toBe(200);
      expect(parseAcceptanceCriteria((await stored(id)).acceptanceCriteria)).toEqual([]);
    });

    it("refuses a blank criterion and an over-long list without writing", async () => {
      const { id } = await makeRequirement();

      const blank = await put(id, { version: 1, acceptanceCriteria: ["ok", "   "] });
      const tooMany = await put(id, {
        version: 1,
        acceptanceCriteria: Array.from({ length: 31 }, (_, i) => `criterion ${i}`),
      });

      expect(blank.status).toBe(400);
      expect(tooMany.status).toBe(400);
      expect(await stored(id)).toEqual({
        acceptanceCriteria: JSON.stringify(GENERATED),
        version: 1,
      });
    });

    it("a stale version's 409 diffs the list as a list, not a JSON string", async () => {
      const { id } = await makeRequirement();
      await put(id, { version: 1, acceptanceCriteria: ["Theirs"] });

      const res = await put(id, { version: 1, acceptanceCriteria: ["Mine"] });

      expect(res.status).toBe(409);
      expect(res.body.error.diff).toEqual([
        { field: "acceptanceCriteria", server: ["Theirs"], client: ["Mine"] },
      ]);
    });

    it("a baseline compare reports the criteria change", async () => {
      const { id } = await makeRequirement();
      const before = (await createManualBaseline(USER, PROJECT, {
        name: "before",
        requirementIds: [id],
      })) as { id: string };
      await put(id, { version: 1, acceptanceCriteria: ["Edited criterion"] });
      const after = (await createManualBaseline(USER, PROJECT, {
        name: "after",
        requirementIds: [id],
      })) as { id: string };

      const compare = await compareBaselines(before.id, after.id);

      expect(compare.changed).toHaveLength(1);
      expect(compare.changed[0]).toMatchObject({
        requirementId: id,
        changedFields: {
          acceptanceCriteria: {
            from: JSON.stringify(GENERATED),
            to: JSON.stringify(["Edited criterion"]),
          },
        },
      });
    });

    it("the issue draft renders the edited criteria, not the generated ones", async () => {
      const { id, analysisId } = await makeRequirement();
      await put(id, { version: 1, acceptanceCriteria: ["A feed refreshes every 60 minutes"] });

      await generateDrafts({
        projectId: PROJECT,
        analysisId,
        targetOwner: "openzigs",
        targetRepo: "flux-v2",
      });

      const draft = await db.issueDraft.findFirstOrThrow({ where: { requirementId: id } });
      expect(draft.body).toContain("- [ ] A feed refreshes every 60 minutes");
      for (const generated of GENERATED) expect(draft.body).not.toContain(generated);
    });
    const IMPORTED_BODY = [
      "Feeds are refreshed periodically.",
      "",
      "## Acceptance criteria",
      "- Imported criterion one",
      "- Imported criterion two",
    ].join("\n");
    const draftBody = async (id: string, analysisId: string) => {
      await generateDrafts({
        projectId: PROJECT,
        analysisId,
        targetOwner: "openzigs",
        targetRepo: "flux-v2",
      });
      return (await db.issueDraft.findFirstOrThrow({ where: { requirementId: id } })).body;
    };

    it("an emptied list is honoured: the draft does not refill it from the body (#990)", async () => {
      const { id, analysisId } = await makeRequirement({ body: IMPORTED_BODY, criteria: [] });
      // Before the clear the body-derived criteria are what the draft (and the editor) show.
      expect(await draftBody(id, analysisId)).toContain("- [ ] Imported criterion one");
      await db.issueDraft.deleteMany({ where: { requirementId: id } });

      const res = await put(id, { version: 1, acceptanceCriteria: [] });
      expect(res.status).toBe(200);

      const body = await draftBody(id, analysisId);
      expect(body).not.toContain("- [ ] Imported criterion");
      expect(body).toContain("No acceptance criteria were derived");
    });

    it("the list API flags an emptied list as cleared, so the editor does not refill it (#990)", async () => {
      const { id, analysisId } = await makeRequirement({ body: IMPORTED_BODY, criteria: [] });
      const before = (await getAnalysisSnapshot(analysisId))?.requirements.find((r) => r.id === id);
      // Never cleared: the editor may prefill from the body, as the draft does.
      expect(before).toMatchObject({ acceptanceCriteria: [], acceptanceCriteriaCleared: false });

      await put(id, { version: 1, acceptanceCriteria: [] });

      const after = (await getAnalysisSnapshot(analysisId))?.requirements.find((r) => r.id === id);
      expect(after).toMatchObject({ acceptanceCriteria: [], acceptanceCriteriaCleared: true });
      expect(await draftBody(id, analysisId)).toContain("No acceptance criteria were derived");
    });

    it("an emptied Gherkin body does not refill from the Gherkin either (#990)", async () => {
      const gherkin = "Given a feed\nWhen it is stale\nThen it is refreshed";
      const { id, analysisId } = await makeRequirement({ body: gherkin, criteria: [] });
      await put(id, { version: 1, acceptanceCriteria: [] });
      expect(await draftBody(id, analysisId)).toContain("No acceptance criteria were derived");
    });
  },
);
