/**
 * #1961 — in a multi-repo project, a code citation into the PRIMARY repository
 * made during a SECONDARY repository's code pass is written `fresh`, with the
 * primary graph and its commit, not `unverified` with no stamp until the next
 * re-ingest.
 *
 * Real SQLite built from the migration chain, shaped like the #1940 repro
 * ("LC Commerce"): the primary repo `orders` holds `src/events/publisher.ts`,
 * the secondary repo `notify` holds `src/db/notify-repo.ts`. The code pass that
 * ran for `notify` cites both files (the agent searches the whole project's
 * graph), and neither citation names its repo. Before the fix the pass's repo
 * (`notify`) was taken as the citation's repo; its graph does not hold the
 * orders file, so that row was resolved to the orders symbol but written with
 * no graph and no commit.
 *
 * Seeded through the public seeding function and read back on a SECOND Prisma
 * client through `prismaAgentCitationDeps` (impact analysis, the reader that
 * counted `unverifiedCitations`), never through the object the writer built.
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
// The BRD staleness nudge a new link fires is not what this test is about.
vi.mock("../src/lib/docs-gen/approved-requirements-staleness.js", () => ({
  noteRequirementCodeLinksChanged: vi.fn(),
}));

const { seedRequirementCodeLinksFromFindings } =
  await import("../src/lib/traceability/seed-code-links-from-findings.js");
const { prismaAgentCitationDeps } = await import("../src/lib/impact-analysis/agent-seeder.js");

const PROJ = "proj-1961";
const USER = "u-1961";
const PUBLISHER = "src/events/publisher.ts";
const NOTIFY_REPO = "src/db/notify-repo.ts";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1961 — a primary-repo citation from a secondary repo's code pass is written fresh",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let reader: PrismaClient;
    const graph = { orders: "", notify: "" };
    const symbol = { orders: "", notify: "" };
    let requirementId = "";
    const before = new Date();

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1961-primary-repo-citation");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      reader = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: "U", email: "u1961@example.test" },
      });
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, description: "", createdById: USER },
      });
      await db.analysis.create({ data: { id: "an-1961", projectId: PROJ, startedById: USER } });

      const repos = [
        { key: "orders", label: "primary", sha: "4d8bb2ba", file: PUBLISHER, name: "publish" },
        { key: "notify", label: "lc-notify", sha: "5d092497", file: NOTIFY_REPO, name: "load" },
      ] as const;
      for (const r of repos) {
        await db.repoConnection.create({
          data: { id: `conn-${r.key}`, projectId: PROJ, label: r.label, createdById: USER },
        });
        graph[r.key] = (
          await db.codeGraph.create({
            data: { projectId: PROJ, repoConnectionId: `conn-${r.key}`, commitSha: r.sha },
          })
        ).id;
        symbol[r.key] = (
          await db.codeSymbol.create({
            data: {
              codeGraphId: graph[r.key],
              projectId: PROJ,
              kind: "function",
              name: r.name,
              qualifiedName: `${r.file}::${r.name}`,
              filePath: r.file,
              startLine: 5,
              endLine: 20,
              language: "typescript",
              contentHash: `hash-${r.key}`,
            },
          })
        ).id;
      }

      // The code pass that ran for the SECONDARY repo cites both repos' code.
      const pass = await db.agentResult.create({
        data: { analysisId: "an-1961", agentKey: "code", connectorId: "conn-notify" },
      });
      const finding = await db.finding.create({
        data: {
          agentResultId: pass.id,
          category: "rationale",
          title: "Order events reach the notifier",
          body: "Orders publish an event that the notifier consumes.",
          confidence: 0.8,
          evidence: JSON.stringify({
            citations: [
              { filePath: PUBLISHER, startLine: 8, endLine: 10 },
              { filePath: NOTIFY_REPO, startLine: 6, endLine: 15 },
            ],
          }),
        },
      });
      requirementId = (
        await db.requirement.create({
          data: {
            projectId: PROJ,
            analysisId: "an-1961",
            title: "Notify on order",
            body: "A customer is notified when an order is placed.",
            labels: JSON.stringify([`finding:${finding.id}`]),
          },
        })
      ).id;

      const summary = await seedRequirementCodeLinksFromFindings({
        analysisId: "an-1961",
        projectId: PROJ,
        requirementIds: [requirementId],
      });
      expect(summary.linksCreated).toBe(2);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      await reader?.$disconnect();
      sqlite?.cleanup();
    });

    it("stores the primary-repo citation with the primary graph, its commit, fresh and validatedAt", async () => {
      const row = await reader.requirementCodeMapping.findFirst({
        where: { projectId: PROJ, requirementId, filePath: PUBLISHER },
      });
      expect(row).toMatchObject({
        source: "analysis-grounding",
        codeSymbolId: symbol.orders,
        codeGraphId: graph.orders,
        commitSha: "4d8bb2ba",
        freshness: "fresh",
      });
      expect(row!.validatedAt).toBeInstanceOf(Date);
      expect(row!.validatedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it("still stamps the secondary repo's own citation with its graph", async () => {
      const row = await reader.requirementCodeMapping.findFirst({
        where: { projectId: PROJ, requirementId, filePath: NOTIFY_REPO },
      });
      expect(row).toMatchObject({
        codeSymbolId: symbol.notify,
        codeGraphId: graph.notify,
        commitSha: "5d092497",
        freshness: "fresh",
      });
    });

    it("impact analysis reads no unverified citation", async () => {
      const links = await prismaAgentCitationDeps(reader).loadCitations(requirementId, PROJ);
      expect(links.map((l) => [l.filePath, l.freshness, l.commitSha])).toEqual([
        [PUBLISHER, "fresh", "4d8bb2ba"],
        [NOTIFY_REPO, "fresh", "5d092497"],
      ]);
    });
  },
);
