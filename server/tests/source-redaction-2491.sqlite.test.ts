/**
 * #2491 — the requirement readers outside #2447's surfaces apply the same
 * source-redaction filter (`source-redaction.ts`), over a REAL SQLite database
 * built by the migration chain and, where the surface is a route, the REAL
 * router with real JWTs.
 *
 * Fixture: one project, two documents (`d-open`, and `d-secret` restricted to
 * Alice). Run `CR` was written under the shared audience (`sourceAccess =
 * shared`, #2446): `req-open` rests on `d-open`, `req-secret` on `d-secret`.
 * Run `LEGACY` is from before #2446 (no marker): its row cites `d-secret` and
 * keeps the shared-audience rule, so every reader sees it. Readers:
 *   - Alice, named on the access list: sees the restricted requirement;
 *   - Bob, a member of the same workspace and role: the placeholder, a 404 or
 *     a count, never its title or body;
 *   - Root, an admin: sees it (the access-list bypass);
 *   - the shared audience (a discussion reply, a generated document): never.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  getPermissionsForRole,
  RESTRICTED_SOURCE_TITLE,
  SIMILAR_REQUIREMENT_SOURCE,
  type AuthPayload,
  type RoleKey,
} from "@metis/shared";
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
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
    resolveDatabaseProvider: () => "sqlite" as const,
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => null }));

const { traceabilityRouter } = await import("../src/routes/traceability.js");
const { projectReviewsRouter, reviewsRouter } = await import("../src/routes/reviews.js");
const { baselinesRouter } = await import("../src/routes/baselines.js");
const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { workspaceRequirementSearchRouter } = await import("../src/routes/requirement-links.js");
const { stakeholdersRouter } = await import("../src/routes/stakeholders.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { loadAnchorContext } = await import("../src/lib/discussions/thread-context.js");
const { synthesizeRequirementsDocument } =
  await import("../src/lib/docs-gen/requirements-scope.js");
const { getMyWork } = await import("../src/lib/my-work/my-work-service.js");
const { getAnalysisSnapshot } = await import("../src/lib/analysis/analysis-service.js");
const { loadSourceGuard, userSourceReader } =
  await import("../src/lib/analysis/source-redaction.js");
const { viewPortfolioAssessment, resolveReaderAccess } =
  await import("../src/lib/portfolio/assessment-view.js");

const WS = "ws-2491";
const P = "proj-2491";
const CR = "cr-2491-shared";
const LEGACY = "cr-2491-legacy";
/** A shared run whose rows cite only `d-open`, but which was asked to read `d-secret` too. */
const CR_INPUT = "cr-2491-input";
const SECRET = "Payroll export for the CFO";
const OPEN = "Customers can pay";
const LEGACY_TITLE = `${SECRET} (legacy)`;

type Who = "alice" | "bob" | "root";
const ROLES: Record<Who, RoleKey> = { alice: "coordinator", bob: "coordinator", root: "admin" };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2491 — requirement readers outside #2447 redact what the reader cannot see a source of (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const payload = (who: Who): AuthPayload => ({
      userId: who,
      username: who,
      role: ROLES[who],
      permissions: getPermissionsForRole(ROLES[who]),
      workspaces: [WS],
    });
    const bearer = (who: Who) => `Bearer ${issueTokens(payload(who)).accessToken}`;
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/reviews", projectReviewsRouter());
      a.use("/api/reviews", reviewsRouter());
      a.use("/api/baselines", baselinesRouter());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use("/api/workspaces/:workspaceId/requirements", workspaceRequirementSearchRouter());
      a.use("/api/projects/:projectId", traceabilityRouter());
      a.use("/api/projects/:projectId", stakeholdersRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (who: Who, path: string) =>
      request(app()).get(path).set("Authorization", bearer(who));
    const post = (who: Who, path: string, body: object) =>
      request(app()).post(path).set("Authorization", bearer(who)).send(body);
    const sources = (documentIds: string[]) => JSON.stringify({ documentIds, chunkIds: [] });
    const text = (res: { body: unknown }) => JSON.stringify(res.body);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2491-requirement-readers");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: "w", slug: WS } });
      for (const key of ["coordinator", "admin"] as const) {
        await db.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      for (const who of Object.keys(ROLES) as Who[]) {
        await db.user.create({
          data: { id: who, username: who, displayName: who, email: `${who}@example.test` },
        });
        await db.userRole.create({ data: { userId: who, roleId: `role-${ROLES[who]}` } });
        await db.workspaceMember.create({ data: { workspaceId: WS, userId: who, role: "member" } });
      }
      await db.project.create({
        data: { id: P, name: P, slug: P, createdById: "alice", workspaceId: WS, status: "active" },
      });
      for (const [id, aclSubjects] of [
        ["d-open", "[]"],
        ["d-secret", JSON.stringify([{ kind: "user", value: "alice" }])],
        // Named only by the coverage record: no row cites it.
        ["d-coverage", JSON.stringify([{ kind: "user", value: "alice" }])],
      ] as const) {
        await db.document.create({
          data: {
            id,
            projectId: P,
            filename: `${id}.md`,
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: `/tmp/${id}`,
            checksum: id,
            uploadedById: "alice",
            status: "ready",
            aclSubjects,
          },
        });
      }
      const coverage = (documentId: string, heading: string) => ({
        documentId,
        filename: `${documentId}.md`,
        status: "read",
        sections: [{ heading, status: "read", statements: 1, kinds: {} }],
        statements: 1,
        requirements: 1,
        droppedUnverified: 0,
      });
      for (const [id, sourceAccess, metadata] of [
        [
          CR,
          "shared",
          {
            documentIds: ["d-open", "d-secret"],
            capability: {
              reasons: [],
              documentReading: {
                documents: [
                  coverage("d-open", "Checkout"),
                  coverage("d-secret", "3 Payroll"),
                  coverage("d-coverage", "4 Bonuses"),
                ],
              },
            },
          },
        ],
        [LEGACY, null, {}],
        [CR_INPUT, "shared", { documentIds: ["d-open", "d-secret"] }],
      ] as const) {
        await db.analysis.create({
          data: {
            id,
            projectId: P,
            startedById: "alice",
            status: "completed",
            completedAt: new Date(),
            title: id,
            sourceAccess,
            metadata: JSON.stringify(metadata),
          },
        });
      }
      const requirement = (
        id: string,
        analysisId: string,
        title: string,
        sourceIds: string | null,
        reviewStatus = "approved",
      ) =>
        db.requirement.create({
          data: {
            id,
            analysisId,
            projectId: P,
            title,
            body: `${title} — body`,
            reviewStatus,
            version: 1,
            acceptanceCriteria: JSON.stringify([`${title} works`]),
            sourceIds,
          },
        });
      await requirement("req-open", CR, OPEN, sources(["d-open"]));
      await requirement("req-secret", CR, SECRET, sources(["d-secret"]));
      await requirement("req-legacy", LEGACY, LEGACY_TITLE, sources(["d-secret"]));
      // Every finding of CR_INPUT records its sources: its corpus is d-open alone,
      // unless the documents it was asked to read count too.
      await db.agentResult.create({
        data: {
          analysisId: CR_INPUT,
          agentKey: "code",
          status: "completed",
          findings: {
            create: [
              {
                category: "security",
                severity: "low",
                title: "The cart is kept",
                body: "b",
                evidence: "{}",
                sourceIds: sources(["d-open"]),
              },
            ],
          },
        },
      });
      await requirement("req-input-run", CR_INPUT, "Checkout is fast", null);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("compares against the literal placeholder, so no assertion passes on an undefined import", () => {
      expect(RESTRICTED_SOURCE_TITLE).toBe("Restricted");
    });

    describe("discussion thread context (sent to the AI reply the whole project reads)", () => {
      const thread = async (
        id: string,
        anchor: { requirementId?: string; analysisId?: string },
      ) => {
        await db.discussionThread.create({
          data: { id, projectId: P, createdById: "alice", title: id, ...anchor },
        });
        return loadAnchorContext({ id, projectId: P });
      };

      it("never puts a restricted requirement's title, body or criteria in the prompt, even in Alice's thread", async () => {
        const block = await thread("t-secret", { requirementId: "req-secret" });
        expect(block).not.toContain("Payroll");
        expect(block).toContain("sources are restricted");
      });

      it("still shows a requirement every member can see", async () => {
        const block = await thread("t-open", { requirementId: "req-open" });
        expect(block).toContain(`Requirement: ${OPEN}`);
        expect(block).toContain(`${OPEN} works`);
      });

      it("lists an anchored run's visible titles and counts the restricted one", async () => {
        const block = await thread("t-run", { analysisId: CR });
        expect(block).toContain(`- ${OPEN}`);
        expect(block).not.toContain("Payroll");
        expect(block).toContain("Requirements: 2");
        expect(block).toContain("(1 not shown: their sources are restricted)");
      });

      it("leaves a run from before #2446 as it was", async () => {
        const block = await thread("t-legacy", { analysisId: LEGACY });
        expect(block).toContain(`- ${LEGACY_TITLE}`);
      });
    });

    describe("traceability", () => {
      beforeAll(async () => {
        for (const requirementId of ["req-open", "req-secret"]) {
          await db.requirementCodeMapping.create({
            data: { requirementId, projectId: P, filePath: "src/pay.ts", source: "manual" },
          });
        }
        // A link req-open borrowed from req-secret (#1839), on a file of its own.
        await db.requirementCodeMapping.create({
          data: {
            requirementId: "req-open",
            projectId: P,
            filePath: "src/borrowed.ts",
            source: SIMILAR_REQUIREMENT_SOURCE,
            originRequirementId: "req-secret",
          },
        });
        await db.requirementLink.create({
          data: {
            sourceRequirementId: "req-open",
            targetRequirementId: "req-secret",
            type: "relates_to",
            createdById: "alice",
          },
        });
      });
      const base = `/api/projects/${P}`;

      it("by-file: Bob is not told the restricted id, only that one was left out", async () => {
        const bob = await get("bob", `${base}/traceability/by-file?filePath=src/pay.ts`);
        expect(bob.status).toBe(200);
        expect(bob.body.data.requirementIds).toEqual(["req-open"]);
        expect(bob.body.data.restrictedCount).toBe(1);
        for (const who of ["alice", "root"] as const) {
          const res = await get(who, `${base}/traceability/by-file?filePath=src/pay.ts`);
          expect([...res.body.data.requirementIds].sort()).toEqual(["req-open", "req-secret"]);
          expect(res.body.data.restrictedCount).toBeUndefined();
        }
      });

      it("test gaps: the restricted requirement is the placeholder for Bob, its title for Alice", async () => {
        const titleOf = (res: {
          body: { data: { untested: Array<{ requirementId: string; title: string }> } };
        }) => res.body.data.untested.find((g) => g.requirementId === "req-secret")?.title;
        const bob = await get("bob", `${base}/traceability/test-gaps`);
        expect(bob.status).toBe(200);
        expect(titleOf(bob)).toBe(RESTRICTED_SOURCE_TITLE);
        expect(text(bob)).not.toContain("Payroll");
        expect(titleOf(await get("alice", `${base}/traceability/test-gaps`))).toBe(SECRET);
        expect(titleOf(await get("root", `${base}/traceability/test-gaps`))).toBe(SECRET);
      });

      it("a linked chain: the restricted counterpart is restricted for Bob, open for Alice", async () => {
        const path = `${base}/requirements/req-open/traceability?includeLinked=true`;
        const bob = await get("bob", path);
        expect(bob.status).toBe(200);
        expect(bob.body.data.linkedChains).toHaveLength(1);
        expect(bob.body.data.linkedChains[0]).toMatchObject({ restricted: true, chain: null });
        expect(bob.body.data.linkedChains[0].link.requirement.title).toBe(RESTRICTED_SOURCE_TITLE);
        expect(text(bob)).not.toContain("Payroll");
        const alice = await get("alice", path);
        expect(alice.body.data.linkedChains[0]).toMatchObject({ restricted: false });
        expect(alice.body.data.linkedChains[0].link.requirement.title).toBe(SECRET);
        expect(alice.body.data.linkedChains[0].chain.requirementTitle).toBe(SECRET);
      });

      it("a borrowed link does not name a restricted origin by its title", async () => {
        const borrowed = (res: {
          body: {
            data: {
              directCode: Array<{ filePath: string; originRequirementLabel?: string | null }>;
            };
          };
        }) => res.body.data.directCode.find((n) => n.filePath === "src/borrowed.ts");
        const bob = await get("bob", `${base}/requirements/req-open/traceability`);
        expect(bob.status).toBe(200);
        expect(borrowed(bob)?.originRequirementLabel).toBeNull();
        expect(text(bob)).not.toContain("Payroll");
        const alice = await get("alice", `${base}/requirements/req-open/traceability`);
        expect(borrowed(alice)?.originRequirementLabel).toBe(SECRET);
      });

      it("a restricted requirement's spec mappings answer Bob as an unknown requirement", async () => {
        expect((await get("bob", `${base}/requirements/req-secret/spec-mappings`)).status).toBe(
          404,
        );
        expect((await get("alice", `${base}/requirements/req-secret/spec-mappings`)).status).toBe(
          200,
        );
      });

      it("refuses Bob creating or deleting a spec mapping on a restricted requirement, as a missing one", async () => {
        await db.generatedDocument.create({
          data: { id: "spec-2491", projectId: P, title: "Spec", status: "completed" },
        });
        const path = `${base}/requirements/req-secret/spec-mappings`;
        const mapping = { specDocumentId: "spec-2491" };
        expect((await post("bob", path, mapping)).status).toBe(404);
        expect(
          await db.requirementSpecMapping.count({ where: { requirementId: "req-secret" } }),
        ).toBe(0);
        const created = await post("alice", path, mapping);
        expect(created.status).toBe(201);
        const del = (who: Who) =>
          request(app())
            .delete(`${path}/${created.body.data.id}`)
            .set("Authorization", bearer(who));
        expect((await del("bob")).status).toBe(404);
        expect(
          await db.requirementSpecMapping.count({ where: { requirementId: "req-secret" } }),
        ).toBe(1);
        expect((await del("alice")).status).toBe(204);
      });
    });

    describe("reviews and baselines", () => {
      beforeAll(async () => {
        await db.reviewRequest.create({
          data: {
            id: "rev-2491",
            projectId: P,
            title: "Sprint sign-off",
            requestedById: "alice",
            status: "in_review",
            items: {
              create: [
                { requirementId: "req-open", pinnedVersion: 1 },
                { requirementId: "req-secret", pinnedVersion: 1 },
              ],
            },
          },
        });
        await db.baseline.create({
          data: {
            id: "bl-open",
            projectId: P,
            name: "open only",
            createdById: "alice",
            items: { create: [{ requirementId: "req-open", version: 1 }] },
          },
        });
        await db.baseline.create({
          data: {
            id: "bl-both",
            projectId: P,
            name: "both",
            createdById: "alice",
            items: {
              create: [
                { requirementId: "req-open", version: 1 },
                { requirementId: "req-secret", version: 1 },
              ],
            },
          },
        });
      });
      type Item = { requirementId: string; requirement: { title: string }; restricted?: boolean };
      const secretItem = (items: Item[]) => items.find((i) => i.requirementId === "req-secret")!;

      it("a review shows Bob the restricted item as the placeholder, Alice its title", async () => {
        const bob = await get("bob", "/api/reviews/rev-2491");
        expect(bob.status).toBe(200);
        expect(secretItem(bob.body.data.review.items)).toMatchObject({
          requirement: { title: RESTRICTED_SOURCE_TITLE },
          restricted: true,
        });
        expect(text(bob)).not.toContain("Payroll");
        const list = await get("bob", `/api/projects/${P}/reviews`);
        expect(list.status).toBe(200);
        expect(text(list)).not.toContain("Payroll");
        for (const who of ["alice", "root"] as const) {
          const res = await get(who, "/api/reviews/rev-2491");
          expect(secretItem(res.body.data.review.items).requirement.title).toBe(SECRET);
          const listed = await get(who, `/api/projects/${P}/reviews`);
          expect(text(listed)).toContain(SECRET);
        }
      });

      it("a baseline's contents give Bob no snapshot of the restricted item", async () => {
        type Pinned = {
          requirementId: string;
          snapshot: { title: string } | null;
          restricted?: boolean;
        };
        const pinned = (res: { body: { data: { items: Pinned[] } } }) =>
          res.body.data.items.find((i) => i.requirementId === "req-secret")!;
        const bob = await get("bob", "/api/baselines/bl-both");
        expect(bob.status).toBe(200);
        expect(pinned(bob)).toMatchObject({ snapshot: null, restricted: true });
        expect(text(bob)).not.toContain("Payroll");
        const alice = await get("alice", "/api/baselines/bl-both");
        expect(pinned(alice).snapshot?.title).toBe(SECRET);
      });

      it("a baseline comparison names the restricted item by the placeholder for Bob", async () => {
        const bob = await get("bob", "/api/baselines/bl-open/compare/bl-both");
        expect(bob.status).toBe(200);
        expect(bob.body.data.added).toEqual([
          { requirementId: "req-secret", version: 1, title: RESTRICTED_SOURCE_TITLE },
        ]);
        expect(text(bob)).not.toContain("Payroll");
        const alice = await get("alice", "/api/baselines/bl-open/compare/bl-both");
        expect(alice.body.data.added[0].title).toBe(SECRET);
      });
    });

    describe("requirement links", () => {
      it("lists a restricted counterpart as the placeholder for Bob, by its title for Alice", async () => {
        const bob = await get("bob", "/api/requirements/req-open/links");
        expect(bob.status).toBe(200);
        expect(bob.body.data.outgoing[0].requirement).toMatchObject({
          id: "req-secret",
          title: RESTRICTED_SOURCE_TITLE,
        });
        expect(text(bob)).not.toContain("Payroll");
        const alice = await get("alice", "/api/requirements/req-open/links");
        expect(alice.body.data.outgoing[0].requirement.title).toBe(SECRET);
      });

      it("refuses Bob a link to a restricted requirement as a missing one; Alice may make it", async () => {
        const body = { targetRequirementId: "req-secret", type: "duplicates" };
        const bob = await post("bob", "/api/requirements/req-open/links", body);
        expect(bob.status).toBe(404);
        expect(text(bob)).not.toContain("Payroll");
        const alice = await post("alice", "/api/requirements/req-open/links", body);
        expect(alice.status).toBe(201);
        expect(alice.body.data.requirement.title).toBe(SECRET);
        await db.requirementLink.deleteMany({ where: { type: "duplicates" } });
      });

      it("the link picker's search never finds a restricted title for Bob, nor counts it", async () => {
        const path = `/api/workspaces/${WS}/requirements/search?q=Payroll`;
        const bob = await get("bob", path);
        expect(bob.status).toBe(200);
        // The pre-#2446 run's row keeps the shared-audience rule, by design.
        expect(bob.body.data.items.map((i: { id: string }) => i.id)).toEqual(["req-legacy"]);
        expect(bob.body.data.total).toBe(1);
        const alice = await get("alice", path);
        expect(alice.body.data.items.map((i: { id: string }) => i.id).sort()).toEqual([
          "req-legacy",
          "req-secret",
        ]);
        expect(alice.body.data.total).toBe(2);
      });
    });

    describe("stakeholders", () => {
      beforeAll(async () => {
        await db.stakeholder.create({ data: { id: "sh-2491", projectId: P, name: "Finance" } });
      });

      it("refuses Bob attributing or detaching a stakeholder on a restricted requirement", async () => {
        const path = `/api/projects/${P}/requirements/req-secret/stakeholders`;
        expect((await post("bob", path, { stakeholderId: "sh-2491" })).status).toBe(404);
        const del = (who: Who) =>
          request(app()).delete(`${path}/sh-2491`).set("Authorization", bearer(who));
        expect((await del("bob")).status).toBe(404);
        expect((await post("alice", path, { stakeholderId: "sh-2491" })).status).toBe(204);
        expect(
          await db.requirementStakeholder.count({ where: { requirementId: "req-secret" } }),
        ).toBe(1);
        expect((await del("alice")).status).toBe(204);
      });

      it("a restricted requirement's stakeholders answer Bob as an unknown requirement", async () => {
        const path = `/api/projects/${P}/requirements/req-secret/stakeholders`;
        expect((await get("bob", path)).status).toBe(404);
        expect((await get("alice", path)).status).toBe(200);
        expect((await get("root", path)).status).toBe(200);
        expect(
          (await get("bob", `/api/projects/${P}/requirements/req-open/stakeholders`)).status,
        ).toBe(200);
      });
    });

    describe("documentation generation (a document the whole project reads)", () => {
      it("leaves a restricted requirement out and says how many were", async () => {
        const doc = await synthesizeRequirementsDocument(P, { analysisId: CR }, "Checkout BRD");
        expect(doc.markdown).toContain(OPEN);
        expect(doc.markdown).not.toContain("Payroll");
        expect(doc.markdown).toContain(
          "1 more requirement(s) in this selection are left out: their sources are restricted.",
        );
        expect(doc.requirementCount).toBe(1);
      });

      it("leaves a run from before #2446 as it was", async () => {
        const doc = await synthesizeRequirementsDocument(P, { analysisId: LEGACY }, "Legacy");
        expect(doc.markdown).toContain(LEGACY_TITLE);
        expect(doc.markdown).not.toContain("left out");
      });
    });

    describe("my work", () => {
      it("names a change request by a source document only to a reader who can see it", async () => {
        const meta = JSON.stringify({
          documentIds: ["d-secret"],
          enhancement: { enableClarification: true },
          structuredRequirements: { requirements: [], totalAmbiguities: 2 },
        });
        for (const who of ["alice", "bob"] as const) {
          await db.analysis.create({
            data: {
              id: `mw-${who}`,
              projectId: P,
              startedById: who,
              status: "completed",
              completedAt: new Date(),
              sourceAccess: "shared",
              metadata: meta,
            },
          });
        }
        const titleFor = async (who: "alice" | "bob") =>
          (
            await getMyWork({ userId: who, role: ROLES[who], workspaces: [WS] })
          ).changeRequests.find((c) => c.id === `mw-${who}`)?.title;
        expect(await titleFor("alice")).toBe("d-secret.md");
        const bob = await titleFor("bob");
        expect(bob).toBeDefined();
        expect(bob).not.toContain("d-secret");
      });
    });

    describe("the run's document coverage record (#2487 panel advisory)", () => {
      it("shows Bob no file name or heading of a document he cannot see", async () => {
        const docs = async (who: Who) =>
          (await getAnalysisSnapshot(CR, { reader: userSourceReader(who) }))!.capability!
            .documentReading!.documents;
        const bob = await docs("bob");
        expect(bob.find((d) => d.documentId === "d-secret")).toMatchObject({
          filename: RESTRICTED_SOURCE_TITLE,
          sections: [],
        });
        // #2448 — and the raw record the snapshot's `metadata` carries.
        const bobMetadata = (await getAnalysisSnapshot(CR, { reader: userSourceReader("bob") }))!
          .metadata;
        expect(JSON.stringify(bobMetadata)).not.toContain("Payroll");
        expect(bob.find((d) => d.documentId === "d-open")?.filename).toBe("d-open.md");
        expect(JSON.stringify(bob)).not.toContain("Payroll");
        const alice = await docs("alice");
        expect(alice.find((d) => d.documentId === "d-secret")?.sections[0]?.heading).toBe(
          "3 Payroll",
        );
        // A document only the coverage record names is decided too: Alice may see
        // it, Bob may not (were it never loaded, both would be refused).
        expect(alice.find((d) => d.documentId === "d-coverage")?.filename).toBe("d-coverage.md");
        expect(bob.find((d) => d.documentId === "d-coverage")?.filename).toBe(
          RESTRICTED_SOURCE_TITLE,
        );
      });
    });

    describe("a shared run's corpus includes the documents it was asked to read (#2487 panel advisory)", () => {
      it("hides what rests on the run as a whole from Bob when an input document is restricted", async () => {
        const rows = [{ analysisId: CR_INPUT, sourceIds: null }];
        expect((await loadSourceGuard(userSourceReader("bob"), rows)).canSeeRun(CR_INPUT)).toBe(
          false,
        );
        expect((await loadSourceGuard(userSourceReader("alice"), rows)).canSeeRun(CR_INPUT)).toBe(
          true,
        );
      });
    });

    describe("a stored portfolio check (#2487 panel advisory)", () => {
      beforeAll(async () => {
        await db.product.create({
          data: {
            id: "prod-2491",
            name: "Billing",
            slug: "prod-2491",
            createdById: "bob",
            workspaceId: WS,
          },
        });
      });
      const check = async (
        id: string,
        criteria: string[],
        notChecked: Array<{ text: string; reason: string; count: number | null }> = [],
      ) => {
        await db.portfolioAssessment.deleteMany({ where: { id } });
        await db.portfolioAssessment.create({
          data: {
            id,
            scope: "product",
            productIds: JSON.stringify(["prod-2491"]),
            status: "completed",
            createdById: "bob",
            sourceProjectId: P,
            sourceAnalysisId: CR,
            statement: 'Requirements of change request "Checkout"',
            notChecked: JSON.stringify(notChecked),
            summary: "The checkout needs the billing service",
            report: JSON.stringify({
              source: "model",
              degraded: false,
              requirements: [
                { text: "Customers pay at checkout", kind: "functional", mentions: [] },
              ],
              products: [],
            }),
            products: {
              create: [
                {
                  productId: "prod-2491",
                  coverage: "partial",
                  technicalDetail: JSON.stringify({
                    criteria: criteria.map((criterion) => ({ criterion, coveredBy: [] })),
                  }),
                },
              ],
            },
          },
        });
        return viewPortfolioAssessment(await resolveReaderAccess(payload("bob")), id);
      };

      it("withholds nothing from Bob for a restricted row the check never read", async () => {
        const view = await check("pa-2491-read-open", [`${OPEN}: ${OPEN} — body`]);
        expect(view).not.toBeNull();
        expect(view!.report?.requirements).toHaveLength(1);
        expect(view!.summary).toBe("The checkout needs the billing service");
      });

      it("withholds from Bob a criterion drawn from the restricted row the check did read", async () => {
        const view = await check("pa-2491-read-secret", [
          `${OPEN}: ${OPEN} — body`,
          `${SECRET}: ${SECRET} — body`,
        ]);
        expect(view).not.toBeNull();
        expect(JSON.stringify(view)).not.toContain("Payroll");
        expect(view!.report?.requirements).toEqual([]);
        const criteria = (
          view!.products[0]!.technicalDetail as { criteria: Array<{ criterion: string }> }
        ).criteria.map((c) => c.criterion);
        expect(criteria).toEqual([`${OPEN}: ${OPEN} — body`, RESTRICTED_SOURCE_TITLE]);
      });

      // The check read its rows when it ran; what the row is now must not
      // decide what a stored check shows (fail closed).
      const STORED_SUMMARY = "The checkout needs the billing service";
      const readSecretAfter = async (
        id: string,
        change: Record<string, unknown>,
        notChecked: Array<{ text: string; reason: string; count: number | null }> = [],
      ) => {
        await db.requirement.update({ where: { id: "req-secret" }, data: change });
        try {
          const view = await check(
            id,
            [`${OPEN}: ${OPEN} — body`, `${SECRET}: ${SECRET} — body`],
            notChecked,
          );
          expect(view).not.toBeNull();
          expect(JSON.stringify(view)).not.toContain("Payroll");
          expect(view!.summary).not.toBe(STORED_SUMMARY);
          expect(view!.report?.requirements).toEqual([]);
          const criteria = (
            view!.products[0]!.technicalDetail as { criteria: Array<{ criterion: string }> }
          ).criteria.map((c) => c.criterion);
          expect(criteria).toEqual([`${OPEN}: ${OPEN} — body`, RESTRICTED_SOURCE_TITLE]);
          return view!;
        } finally {
          await db.requirement.update({
            where: { id: "req-secret" },
            data: { reviewStatus: "approved", deletedAt: null, title: SECRET },
          });
        }
      };

      it("withholds a read row's text from Bob when the row was rejected after the check", async () => {
        await readSecretAfter("pa-2491-rejected-after", { reviewStatus: "rejected" });
      });

      it("withholds a read row's text from Bob when the row was deferred after the check", async () => {
        await readSecretAfter("pa-2491-deferred-after", { reviewStatus: "deferred" });
      });

      it("withholds a read row's text from Bob when the row was deleted after the check", async () => {
        await readSecretAfter("pa-2491-deleted-after", { deletedAt: new Date() });
      });

      it("withholds a read row's text from Bob when the row was renamed after the check", async () => {
        const view = await readSecretAfter("pa-2491-renamed-after", { title: "Quarterly report" }, [
          { text: `${SECRET}: ${SECRET} — body, cut`, reason: "text-cut", count: 12 },
          { text: "1 requirement", reason: "restricted-source", count: 1 },
        ]);
        expect(view.notChecked.map((n) => n.text)).toEqual([
          RESTRICTED_SOURCE_TITLE,
          "1 requirement",
        ]);
      });

      it("shows Bob a not-checked entry cut from a row he can see", async () => {
        await db.requirement.update({ where: { id: "req-secret" }, data: { title: SECRET } });
        const view = await check(
          "pa-2491-open-cut",
          [`${OPEN}: ${OPEN} — body`],
          [{ text: `${OPEN}: ${OPEN} —…`, reason: "text-cut", count: 3 }],
        );
        expect(view!.notChecked.map((n) => n.text)).toEqual([`${OPEN}: ${OPEN} —…`]);
        expect(view!.summary).toBe(STORED_SUMMARY);
      });
    });
  },
);
