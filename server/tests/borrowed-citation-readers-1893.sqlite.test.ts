/**
 * #1893 (epic #1828) — a code link borrowed from a similar requirement
 * (`similar-requirement`, #1839) is a hypothesis no analysis has checked. The
 * readers that cannot label it "borrowed" leave it out:
 *
 *   - the issue-draft "Related code" section (`loadDraftCodeLinks`), which
 *     publishes to GitHub or Jira with no provenance;
 *   - the requirements BRD and the reader-BRD scope (`loadScopedRequirements`,
 *     `requirementsInScope`, through `loadApprovedRequirements`), by path and
 *     by repository;
 *   - the analysis traceability matrix (`getTraceabilityMatrix`).
 *
 * Real SQLite from the migration chain. Each requirement holds its own
 * (`manual`) link, a borrowed one, or both, so each reader is asked a question
 * the borrowed row alone would answer differently.
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
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));

const { loadDraftCodeLinks } = await import("../src/lib/publishing/draft-code-links.js");
const { loadScopedRequirements, renderRequirementsDocument } =
  await import("../src/lib/docs-gen/requirements-scope.js");
const { loadApprovedRequirements } =
  await import("../src/lib/docs-gen/approved-requirements-section.js");
const { getTraceabilityMatrix } = await import("../src/lib/analysis/traceability-service.js");
const { loadBackfillData } = await import("../src/lib/traceability/backfill-spec-links.js");

const USER = "u1893";
const PROJECT = "p1893";
const RUN = "run-1893";
/** Holds its own link and a borrowed one. */
const BOTH = "r1893-both";
/** Holds a borrowed link only. */
const BORROWER = "r1893-borrower";
/** The requirement the links were borrowed from. */
const ORIGIN = "r1893-origin";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1893 — readers that cannot say 'borrowed' leave borrowed code links out (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const mapping = (
      requirementId: string,
      filePath: string,
      codeSymbolId: string,
      borrowed: boolean,
    ) =>
      db.requirementCodeMapping.create({
        data: {
          requirementId,
          projectId: PROJECT,
          filePath,
          codeSymbolId,
          startLine: 1,
          endLine: 2,
          confidence: borrowed ? 0.4 : 0.9,
          source: borrowed ? "similar-requirement" : "manual",
          originRequirementId: borrowed ? ORIGIN : null,
        },
      });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1893-borrowed-citation-readers");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: "u1893@x.test" },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
      await db.analysis.create({
        data: { id: RUN, projectId: PROJECT, startedById: USER, status: "completed" },
      });
      await db.repoConnection.create({
        data: {
          id: "repo-1893",
          projectId: PROJECT,
          label: "billing",
          ownerOrOrg: "acme",
          repoName: "billing",
        },
      });
      await db.codeGraph.create({
        data: { id: "graph-1893", projectId: PROJECT, repoConnectionId: "repo-1893" },
      });
      for (const [id, filePath] of [
        ["s-own", "src/own.ts"],
        ["s-borrowed", "lib/borrowed.ts"],
      ] as const) {
        await db.codeSymbol.create({
          data: {
            id,
            codeGraphId: "graph-1893",
            projectId: PROJECT,
            kind: "function",
            name: id,
            qualifiedName: `${filePath}::${id}`,
            filePath,
            startLine: 1,
            endLine: 2,
            language: "ts",
            contentHash: id,
          },
        });
      }
      for (const id of [BOTH, BORROWER, ORIGIN]) {
        await db.requirement.create({
          data: {
            id,
            analysisId: RUN,
            projectId: PROJECT,
            title: `Title of ${id}`,
            body: `Body of ${id}`,
            reviewStatus: "approved",
          },
        });
      }
      await mapping(ORIGIN, "lib/borrowed.ts", "s-borrowed", false);
      await mapping(BOTH, "src/own.ts", "s-own", false);
      await mapping(BOTH, "lib/borrowed.ts", "s-borrowed", true);
      await mapping(BORROWER, "lib/borrowed.ts", "s-borrowed", true);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the issue-draft 'Related code' section lists only the requirement's own links", async () => {
      const links = await loadDraftCodeLinks(PROJECT, [BOTH, BORROWER], {
        owner: "acme",
        repo: "billing",
      });
      expect(links).not.toBeNull();
      const both = links!.byRequirement.get(BOTH)!;
      expect(both.links.map((l) => l.filePath)).toEqual(["src/own.ts"]);
      expect(both.total).toBe(1);
      expect(links!.byRequirement.get(BORROWER)).toEqual({ links: [], total: 0 });
    });

    it("the requirements BRD never lists a borrowed link as the requirement's code", async () => {
      const scoped = await loadScopedRequirements(PROJECT, { requirementIds: [BOTH, BORROWER] });
      const byId = new Map(scoped.map((r) => [r.id, r.codeMappings.map((m) => m.filePath)]));
      expect(byId.get(BOTH)).toEqual(["src/own.ts"]);
      expect(byId.get(BORROWER)).toEqual([]);
      const doc = renderRequirementsDocument("Requirements", { requirementIds: [BOTH] }, scoped);
      expect(doc).toContain("src/own.ts");
      expect(doc).not.toContain("lib/borrowed.ts");
      expect(doc).not.toContain("similar-requirement");
    });

    it("a borrowed link brings no requirement into a path-scoped reader BRD", async () => {
      const ids = (await loadApprovedRequirements(PROJECT, { pathPrefixes: ["lib"] })).map(
        (r) => r.id,
      );
      expect(ids).toEqual([ORIGIN]);
    });

    it("a borrowed link brings no requirement into a repository-scoped reader BRD", async () => {
      // `lib/` holds the borrowed links only: by symbol, only the origin's own link is there.
      const ids = (
        await loadApprovedRequirements(PROJECT, {
          repoConnectorId: "repo-1893",
          pathPrefixes: ["lib"],
        })
      ).map((r) => r.id);
      expect(ids).toEqual([ORIGIN]);
      // The whole repository: BOTH is in by its own link, the borrower is still out.
      const all = (await loadApprovedRequirements(PROJECT, { repoConnectorId: "repo-1893" })).map(
        (r) => r.id,
      );
      expect(all.sort()).toEqual([BOTH, ORIGIN].sort());
    });

    it("the analysis traceability matrix shows no borrowed link as a mapping", async () => {
      const requirement = (id: string) => ({
        id,
        title: `Title of ${id}`,
        coverage: null,
        verdict: null,
        evidenceFindingIds: [],
      });
      const matrix = await getTraceabilityMatrix(RUN, {
        prisma: db as never,
        resolveTests: async () => new Map(),
        loadSnapshot: async () =>
          ({
            id: RUN,
            projectId: PROJECT,
            agents: [],
            requirements: [requirement(BOTH), requirement(BORROWER)],
          }) as never,
      });
      const paths = new Map(
        matrix!.rows.map((row) => [row.requirementId, row.codeLocations.map((c) => c.filePath)]),
      );
      expect(paths.get(BOTH)).toEqual(["src/own.ts"]);
      expect(paths.get(BORROWER)).toEqual([]);
    });

    it("the spec-link backfill never links specs from, or derives spec code out of, a borrowed link", async () => {
      const data = await loadBackfillData(PROJECT, db as never);
      const code = new Map(data.requirements.map((r) => [r.id, r.code.map((c) => c.filePath)]));
      expect(code.get(BOTH)).toEqual(["src/own.ts"]);
      expect(code.get(BORROWER)).toEqual([]);
      expect(code.get(ORIGIN)).toEqual(["lib/borrowed.ts"]);
    });
  },
);
