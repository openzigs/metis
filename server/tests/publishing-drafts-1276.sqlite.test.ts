/**
 * Issue #1276 — three publish-draft defects, proven against a REAL SQLite
 * database built by the real migration chain, through Generate and the
 * dry-run publisher (which shows exactly the bodies and labels a live run
 * sends, without any network):
 *
 *  1. a sub-issue whose epic an EARLIER batch published names it by `#N` and link;
 *  2. the epic's title counts the requirements it covers, and an epic already
 *     drafted keeps its title when the scope changes (it is the dedup key);
 *  3. `unverified` stays on the draft in METIS, is never upserted or sent, and
 *     the issue body carries one plain sentence instead.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { DryRunPlan } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

const { generateDrafts } = await import("../src/lib/publishing/draft-generator.js");
const { runBatch } = await import("../src/lib/publishing/publisher.js");
const { computeDedupHash } = await import("../src/lib/publishing/dedup.js");

const T0 = "2026-09-01T00:00:00.000Z";
const target = { targetOwner: "acme", targetRepo: "miniflux" };
const NOTE =
  "METIS could not confirm the code references behind this item; check them before relying on them.";
const LIST = "- Mark all as read\n- Terminate sessions\n- Per-feed IPv6";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1276 — parent epic outside the batch, epic title count, internal `unverified` (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1276-publishing");
      sqlite.exec(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES ('u1','u1','U1','u1@example.test',?,?)`,
        [T0, T0],
      );
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    /** A project whose run text lists THREE requirements, and whose analysis produced FOUR. */
    async function seed(p: string) {
      await db.project.create({
        data: { id: p, name: "Miniflux", slug: `slug-${p}`, createdById: "u1" },
      });
      const analysisId = `an_${p}`;
      await db.analysis.create({
        data: {
          id: analysisId,
          projectId: p,
          startedById: "u1",
          startedAt: new Date("2026-09-29T14:05:00.000Z"),
          metadata: JSON.stringify({ extraInstructions: LIST }),
        },
      });
      for (const [i, title, labels] of [
        [1, "Mark all as read", ["feeds"]],
        [2, "Terminate sessions", ["security", "unverified"]],
        [3, "Per-feed IPv6", ["network"]],
        [4, "Refresh timestamp", ["feeds"]],
      ] as const) {
        await db.requirement.create({
          data: {
            id: `r${i}_${p}`,
            projectId: p,
            analysisId,
            title,
            body: `${title} body\n\n## Acceptance criteria\n\n- ${title} works`,
            reviewStatus: "approved",
            labels: JSON.stringify(labels),
          },
        });
      }
      return analysisId;
    }

    const live = (projectId: string) =>
      db.issueDraft.findMany({
        where: { projectId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      });

    async function dryRun(projectId: string, draftIds: string[]): Promise<DryRunPlan> {
      const batch = await db.publishBatch.create({
        data: {
          projectId,
          ...target,
          dryRun: true,
          startedById: "u1",
          metadata: JSON.stringify({ draftIds, additionalLabels: [] }),
        },
      });
      await runBatch({ batchId: batch.id, dryRun: true, secretRef: null });
      const row = await db.publishBatch.findUniqueOrThrow({ where: { id: batch.id } });
      return JSON.parse(row.dryRunPlan ?? "null") as DryRunPlan;
    }

    /** Record the epic as published (#41) by an earlier, completed batch. */
    async function publishEpicEarlier(projectId: string, epicId: string, owner = "Acme") {
      const epic = await db.issueDraft.update({
        where: { id: epicId },
        data: { status: "published" },
      });
      const batch = await db.publishBatch.create({
        data: {
          projectId,
          targetOwner: owner,
          targetRepo: "Miniflux",
          status: "completed",
          startedById: "u1",
        },
      });
      await db.publishedIssue.create({
        data: {
          batchId: batch.id,
          draftId: epicId,
          issueNumber: 41,
          issueId: "I_kwDOepic41",
          htmlUrl: "https://github.com/acme/miniflux/issues/41",
          status: "created",
          dedupHash: computeDedupHash("acme", "miniflux", epic.title),
          bodyHash: "x",
        },
      });
    }

    it("titles the epic by the four requirements it covers, not the three the text lists", async () => {
      const analysisId = await seed("p1");
      await generateDrafts({ projectId: "p1", analysisId, ...target });
      const epics = (await live("p1")).filter((d) => d.draftType === "epic");
      expect(epics.map((e) => e.title)).toEqual([
        "[Epic] Miniflux — 4 requirements (analysis of 2026-09-29 14:05:00 UTC)",
      ]);
      expect(epics[0]!.body).toContain("**Total requirements**: 4");
    });

    it("keeps the published epic's title when the scope changes: no rename, no second epic", async () => {
      const analysisId = "an_p1";
      const [epic] = (await live("p1")).filter((d) => d.draftType === "epic");
      await publishEpicEarlier("p1", epic!.id);
      // A reviewer rejects one requirement; Generate runs again over three.
      await db.requirement.update({ where: { id: "r4_p1" }, data: { reviewStatus: "rejected" } });
      await generateDrafts({ projectId: "p1", analysisId, ...target });
      const epics = (await live("p1")).filter((d) => d.draftType === "epic");
      expect(epics).toHaveLength(1);
      expect(epics[0]).toMatchObject({ id: epic!.id, title: epic!.title, status: "published" });
      expect(epics[0]!.dedupHash).toBe(epic!.dedupHash);
      expect(epics[0]!.body).toContain("**Total requirements**: 3");
    });

    it("names the earlier-published epic by #N and link in a sub-issue published on its own", async () => {
      const features = (await live("p1")).filter((d) => d.draftType !== "epic");
      const plan = await dryRun(
        "p1",
        features.map((f) => f.id),
      );
      const creates = plan.actions.filter((a) => a.kind === "issue.create");
      expect(creates).toHaveLength(3);
      for (const c of creates) {
        expect(c.body!.split("\n")[0]).toMatch(
          /^> Parent epic: \*\*\[Epic\] Miniflux — 4 requirements .*\*\* \(\[#41\]\(https:\/\/github\.com\/acme\/miniflux\/issues\/41\)\)$/,
        );
      }
      // The stored drafts are not rewritten.
      for (const f of await live("p1")) {
        expect(f.body).not.toContain("#41");
      }
    });

    it("keeps `unverified` on the draft, never upserts or sends it, and says it in one sentence", async () => {
      const drafts = await live("p1");
      const flagged = drafts.find((d) => d.title === "[Feature] Terminate sessions")!;
      expect(JSON.parse(flagged.labels)).toContain("unverified");

      const plan = await dryRun(
        "p1",
        drafts.filter((d) => d.draftType !== "epic").map((d) => d.id),
      );
      const upserted = plan.actions
        .filter((a) => a.kind === "label.upsert")
        .flatMap((a) => a.labels ?? []);
      expect(upserted).not.toContain("unverified");
      const sent = plan.actions.find(
        (a) => a.kind === "issue.create" && a.title === "[Feature] Terminate sessions",
      )!;
      expect(sent.labels).not.toContain("unverified");
      expect(sent.labels).toContain("security");
      expect(sent.body!.split(NOTE)).toHaveLength(2);
      const other = plan.actions.find(
        (a) => a.kind === "issue.create" && a.title === "[Feature] Mark all as read",
      )!;
      expect(other.body).not.toContain(NOTE);
    });

    it("leaves the body of a sub-issue whose epic is in the same batch as generated", async () => {
      const analysisId = await seed("p2");
      await generateDrafts({ projectId: "p2", analysisId, ...target });
      const drafts = await live("p2");
      const plan = await dryRun(
        "p2",
        drafts.map((d) => d.id),
      );
      const feature = drafts.find((d) => d.title === "[Feature] Mark all as read")!;
      const sent = plan.actions.find((a) => a.kind === "issue.create" && a.draftId === feature.id)!;
      expect(sent.body!.split("\n")[0]).toBe(feature.body.split("\n")[0]);
      expect(sent.body).not.toContain("#41");
      expect(plan.actions.some((a) => a.kind === "subIssue.attach")).toBe(true);
    });
  },
);
