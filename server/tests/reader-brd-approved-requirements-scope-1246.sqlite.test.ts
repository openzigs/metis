/**
 * Issue #1246 — a repository- or path-scoped reader BRD lists only the
 * approved requirements with a code link in its scope; an approved
 * requirement with no code link is left out of it. Its input snapshot item
 * (`approvedRequirementsItem`) and the out-of-date mark
 * (`approvedRequirementsOutOfDate`) cover that same scoped list.
 *
 * Read against a REAL migrated SQLite database: two repositories of one
 * project that share a file path, a mapping whose symbol was deleted, a merged
 * pull request's file, a requirement with no link, and a mapping recorded
 * under another project.
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

const state = vi.hoisted(() => ({ db: null as unknown, layout: vi.fn() }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/docs-gen/brd-layout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/docs-gen/brd-layout.js")>()),
  readBrdLayoutSetting: state.layout,
}));

const { approvedRequirementsFacts, loadApprovedRequirements } =
  await import("../src/lib/docs-gen/approved-requirements-section.js");
const { approvedRequirementsScopeOf, prNamesRepository } =
  await import("../src/lib/docs-gen/approved-requirements-scope.js");
const { approvedRequirementsItem } = await import("../src/lib/docs-gen/generation-inputs.js");
const { approvedRequirementsOutOfDate } =
  await import("../src/lib/docs-gen/approved-requirements-currency.js");
const { APPROVED_REQUIREMENTS_ITEM, fingerprintInputs } =
  await import("../src/lib/docs-gen/regeneration-plan.js");
const { legacyGeneratedDocVersionManifest } =
  await import("../src/lib/docs-gen/generated-doc-provenance.js");

const USER = "u1246";
const PROJECT = "p1246";
const OTHER = "q1246";
const RUN = "run-1246";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "Issue #1246 — the approved requirements of a scoped reader BRD (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const symbol = (id: string, graph: string, filePath: string, projectId = PROJECT) =>
      db.codeSymbol.create({
        data: {
          id,
          codeGraphId: graph,
          projectId,
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
    const requirement = (id: string, priority: string, reviewStatus = "approved") =>
      db.requirement.create({
        data: {
          id,
          analysisId: RUN,
          projectId: PROJECT,
          title: `Title of ${id}`,
          body: `Body of ${id}`,
          priority,
          reviewStatus,
          acceptanceCriteria: JSON.stringify([`Criterion of ${id}`]),
        },
      });
    const mapping = (requirementId: string, filePath: string, codeSymbolId: string | null) =>
      db.requirementCodeMapping.create({
        data: { requirementId, projectId: PROJECT, filePath, codeSymbolId },
      });
    const ids = async (scope: Parameters<typeof loadApprovedRequirements>[1]) =>
      (await loadApprovedRequirements(PROJECT, scope)).map((r) => r.id);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1246-approved-requirements-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      state.layout.mockReturnValue({ layout: "reader" });
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: "u1246@x.test" },
      });
      for (const id of [PROJECT, OTHER]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: USER } });
      }
      await db.analysis.create({
        data: { id: RUN, projectId: PROJECT, startedById: USER, status: "completed" },
      });
      await db.repoConnection.create({
        data: {
          id: "repo-a",
          projectId: PROJECT,
          label: "a",
          ownerOrOrg: "acme",
          repoName: "billing",
        },
      });
      await db.repoConnection.create({
        data: { id: "repo-b", projectId: PROJECT, label: "b", ownerOrOrg: "acme", repoName: "web" },
      });
      await db.codeGraph.create({
        data: { id: "graph-a", projectId: PROJECT, repoConnectionId: "repo-a" },
      });
      await db.codeGraph.create({
        data: { id: "graph-b", projectId: PROJECT, repoConnectionId: "repo-b" },
      });
      await symbol("s-invoice", "graph-a", "src/billing/invoice.ts");
      await symbol("s-tax", "graph-a", "src/billing/tax.ts");
      await symbol("s-util-a", "graph-a", "src/shared/util.ts");
      // The same path in the other repository.
      await symbol("s-util-b", "graph-b", "src/shared/util.ts");
      await symbol("s-web", "graph-b", "web/app.ts");

      // Highest priority first; no two in one scoped list share a priority.
      await requirement("billing", "critical");
      await mapping("billing", "src/billing/invoice.ts", "s-invoice");
      await requirement("web", "high");
      await mapping("web", "web/app.ts", "s-web");
      // Its symbol is in repository b, at a path repository a also has.
      await requirement("shared-in-b", "medium");
      await mapping("shared-in-b", "src/shared/util.ts", "s-util-b");
      // Only a merged pull request's file links it to code.
      await requirement("pr-only", "medium");
      await db.requirementImplementation.create({
        data: {
          requirementId: "pr-only",
          prNumber: 7,
          prUrl: "https://example.test/pull/7",
          commitSha: "abc",
          filePath: "src/billing/tax.ts",
          mergedAt: new Date("2026-10-01T00:00:00Z"),
        },
      });
      // Its symbol was deleted by a re-ingest: the path places it.
      await requirement("orphan-mapping", "low");
      await mapping("orphan-mapping", "src/billing/invoice.ts", null);
      // No code link at all.
      await requirement("unmapped", "low");
      // Linked only under another project.
      await requirement("foreign-link", "low");
      await db.requirementCodeMapping.create({
        data: {
          requirementId: "foreign-link",
          projectId: OTHER,
          filePath: "src/billing/invoice.ts",
          codeSymbolId: "s-invoice",
        },
      });
      // Linked into scope, but not approved.
      await requirement("draft-billing", "critical", "draft");
      await mapping("draft-billing", "src/billing/invoice.ts", "s-invoice");
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("lists every approved requirement, linked or not, in an unscoped BRD", async () => {
      // Rows created in the same millisecond: compare as a set.
      expect((await ids({})).sort()).toEqual(
        [
          "billing",
          "web",
          "shared-in-b",
          "pr-only",
          "orphan-mapping",
          "unmapped",
          "foreign-link",
        ].sort(),
      );
      expect(await ids(undefined)).toEqual(await ids({}));
    });

    it("lists only the requirements linked to a repository's code, and none without a link", async () => {
      expect(await ids({ repoConnectorId: "repo-a" })).toEqual([
        "billing",
        "pr-only",
        "orphan-mapping",
      ]);
      // A shared path is placed by the mapping's symbol, not by the path.
      expect(await ids({ repoConnectorId: "repo-b" })).toEqual(["web", "shared-in-b"]);
      expect(await ids({ repoConnectorId: "no-such-repo" })).toEqual([]);
    });

    it("places a merged pull request by the repository its URL names, before its file is indexed", async () => {
      await requirement("pr-unindexed", "high");
      await db.requirementImplementation.create({
        data: {
          requirementId: "pr-unindexed",
          prNumber: 9,
          // Owner and name as the host spells them: compared case-insensitively.
          prUrl: "https://github.com/Acme/Billing/pull/9",
          commitSha: "def",
          // Added by the pull request: no symbol in any graph yet.
          filePath: "src/billing/refunds.ts",
          mergedAt: new Date("2026-10-02T00:00:00Z"),
        },
      });
      try {
        expect(await ids({ repoConnectorId: "repo-a" })).toEqual([
          "billing",
          "pr-unindexed",
          "pr-only",
          "orphan-mapping",
        ]);
        expect(await ids({ repoConnectorId: "repo-b" })).toEqual(["web", "shared-in-b"]);
        // Still within the paths of a path-scoped repository BRD only.
        expect(await ids({ repoConnectorId: "repo-a", pathPrefixes: ["src/shared"] })).toEqual([]);
      } finally {
        await db.requirement.update({
          where: { id: "pr-unindexed" },
          data: { deletedAt: new Date() },
        });
      }
    });

    it("never counts a mapping to another project's symbol, even one whose graph names this repository", async () => {
      // Another project's graph that (wrongly) records this project's repository.
      await db.codeGraph.create({
        data: { id: "graph-foreign", projectId: OTHER, repoConnectionId: "repo-a" },
      });
      await symbol("s-foreign", "graph-foreign", "lib/foreign.ts", OTHER);
      await requirement("foreign-symbol", "high");
      await mapping("foreign-symbol", "lib/foreign.ts", "s-foreign");
      try {
        expect(await ids({ repoConnectorId: "repo-a" })).not.toContain("foreign-symbol");
      } finally {
        await db.requirement.update({
          where: { id: "foreign-symbol" },
          data: { deletedAt: new Date() },
        });
      }
    });

    it("matches a pull request URL to a repository by owner and name only", () => {
      const repo = { ownerOrOrg: "Acme", repoName: "billing" };
      expect(prNamesRepository("https://github.com/acme/billing/pull/1", repo)).toBe(true);
      expect(prNamesRepository("https://ghe.example/acme/billing/pull/1", repo)).toBe(true);
      expect(prNamesRepository("https://github.com/acme/billing-old/pull/1", repo)).toBe(false);
      expect(prNamesRepository("https://github.com/other/billing/pull/1", repo)).toBe(false);
      expect(prNamesRepository("https://example.test/pull/7", repo)).toBe(false);
      expect(prNamesRepository("not a url", repo)).toBe(false);
      expect(
        prNamesRepository("https://github.com/acme/billing/pull/1", {
          ownerOrOrg: null,
          repoName: "billing",
        }),
      ).toBe(false);
    });

    it("lists only the requirements linked under a path scope, matched segment by segment", async () => {
      expect(await ids({ pathPrefixes: ["src/billing"] })).toEqual([
        "billing",
        "pr-only",
        "orphan-mapping",
      ]);
      expect(await ids({ pathPrefixes: ["web", "src/shared"] })).toEqual(["web", "shared-in-b"]);
      expect(await ids({ pathPrefixes: ["src/bill"] })).toEqual([]);
    });

    it("needs both the repository and the path in a path-scoped repository BRD", async () => {
      expect(await ids({ repoConnectorId: "repo-a", pathPrefixes: ["src/shared"] })).toEqual([]);
      expect(await ids({ repoConnectorId: "repo-b", pathPrefixes: ["src/shared"] })).toEqual([
        "shared-in-b",
      ]);
      expect(await ids({ repoConnectorId: "repo-a", pathPrefixes: ["src/billing"] })).toEqual([
        "billing",
        "pr-only",
        "orphan-mapping",
      ]);
    });

    it("reads a stored document's scope as generation does", () => {
      expect(
        approvedRequirementsScopeOf({
          scope: "repository",
          scopeFilter: '{"repoConnectorId":"repo-a","pathPrefixes":["src/billing/"]}',
        }),
      ).toEqual({ repoConnectorId: "repo-a", pathPrefixes: ["src/billing"] });
      expect(approvedRequirementsScopeOf({ scope: "full", scopeFilter: "{}" })).toEqual({});
      // A full document's stray repository id is not a repository scope.
      expect(
        approvedRequirementsScopeOf({ scope: "full", scopeFilter: '{"repoConnectorId":"repo-a"}' }),
      ).toEqual({});
      // A corrupted path scope fails loudly rather than widening to the project.
      expect(() =>
        approvedRequirementsScopeOf({ scope: "full", scopeFilter: '{"pathPrefixes":["../x"]}' }),
      ).toThrow(/path scope is invalid/);
    });

    describe("the snapshot item and the out-of-date mark cover the scoped list", () => {
      const repoDoc = { scope: "repository", scopeFilter: '{"repoConnectorId":"repo-a"}' };

      it("hashes exactly the listed requirements' shown fields", async () => {
        const scope = approvedRequirementsScopeOf(repoDoc);
        const listed = await loadApprovedRequirements(PROJECT, scope);
        const unscoped = await approvedRequirementsItem(PROJECT);
        const scoped = await approvedRequirementsItem(PROJECT, scope);
        expect(scoped).not.toBe(unscoped);
        expect(
          JSON.parse(approvedRequirementsFacts(listed)).map((r: { id: string }) => r.id),
        ).toEqual(["billing", "pr-only", "orphan-mapping"]);
      });

      it("is unmoved by an approval or edit outside the scope, and moved by one inside", async () => {
        const scope = approvedRequirementsScopeOf(repoDoc);
        const before = await approvedRequirementsItem(PROJECT, scope);
        const unscopedBefore = await approvedRequirementsItem(PROJECT);
        await db.requirement.update({ where: { id: "unmapped" }, data: { title: "Edited" } });
        await db.requirement.update({ where: { id: "web" }, data: { title: "Edited too" } });
        expect(await approvedRequirementsItem(PROJECT, scope)).toBe(before);
        expect(await approvedRequirementsItem(PROJECT)).not.toBe(unscopedBefore);
        await db.requirement.update({
          where: { id: "pr-only" },
          data: { title: "Edited in scope" },
        });
        expect(await approvedRequirementsItem(PROJECT, scope)).not.toBe(before);
      });

      it("marks a scoped BRD out of date only for a change in its scope, a new code link included", async () => {
        const doc = await db.generatedDocument.create({
          data: {
            projectId: PROJECT,
            title: "Billing BRD",
            ...repoDoc,
            status: "ready",
            autoUpdate: false,
          },
        });
        const manifest = {
          ...legacyGeneratedDocVersionManifest({
            projectId: PROJECT,
            generatedDocumentId: doc.id,
            version: 1,
          }),
          inputSnapshot: fingerprintInputs({
            settings: "s",
            [APPROVED_REQUIREMENTS_ITEM]: await approvedRequirementsItem(
              PROJECT,
              approvedRequirementsScopeOf(doc),
            ),
          }),
        };
        await db.generatedDocumentVersion.create({
          data: {
            documentId: doc.id,
            version: 1,
            content: "# BRD",
            provenanceManifest: JSON.stringify(manifest),
          },
        });
        const outOfDate = async () =>
          approvedRequirementsOutOfDate(
            await db.generatedDocument.findUniqueOrThrow({ where: { id: doc.id } }),
          );
        expect(await outOfDate()).toBe(false);
        // Outside the scope: an unmapped requirement edited, another repository's too.
        await db.requirement.update({ where: { id: "unmapped" }, data: { body: "New body" } });
        await db.requirement.update({ where: { id: "web" }, data: { body: "New body" } });
        expect(await outOfDate()).toBe(false);
        // A code link brings the unmapped requirement into the scope.
        await mapping("unmapped", "src/billing/tax.ts", "s-tax");
        expect(await outOfDate()).toBe(true);
      });
    });
  },
);
