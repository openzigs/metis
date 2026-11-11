/**
 * #2272 — `/api/portfolio-assessments` checks a document's requirements, in
 * chosen products, and lists what it did not check: on a real SQLite database
 * built by the migration chain, over the #1622 synthetic portfolio, with real
 * JWTs, the real router, product access, federated search (fixture index) and
 * engine. The model is scripted; the document reader and the stored file are
 * doubles.
 *
 * Users: Mia is in both workspaces, Ana in ws-a, Ola in ws-b.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  PORTFOLIO_STATEMENT_MAX_CHARS,
  getPermissionsForRole,
  type AuthPayload,
  type PortfolioAssessmentView,
} from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DocumentReading } from "../src/lib/document-reader/reader.js";
import type { PortfolioDocumentReader } from "../src/lib/portfolio/document-requirements.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import {
  P1,
  P2,
  PROJECTS,
  RC_P1_API,
  RESET_CRITERIA,
  WS_A,
  WS_B,
  fixtureKnowledgeService,
  scriptedProvider,
  seedPortfolio,
} from "./fixtures/portfolio-gap-1622.js";

const state = vi.hoisted(() => {
  process.env.AI_OFFLINE = "1";
  // More starts than the default per-user window allows (read per request).
  process.env.PORTFOLIO_ASSESSMENT_START_RATE_LIMIT_MAX = "1000";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prisma.js")>();
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { portfolioAssessmentsRouter } = await import("../src/routes/portfolio-assessments.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { FederatedSearchService } = await import("../src/lib/rag/federated-search-service.js");

const USERS: Record<string, string[]> = {
  mia: [WS_A, WS_B],
  ana: [WS_A],
  ola: [WS_B],
};
type Who = keyof typeof USERS;

const payload = (who: Who): AuthPayload => ({
  userId: who,
  username: who,
  role: "coordinator",
  permissions: getPermissionsForRole("coordinator"),
  workspaces: USERS[who],
});
const bearer = (who: Who) => `Bearer ${issueTokens(payload(who)).accessToken}`;

/** A document in ws-a's accounts project, one in ws-b's billing project, one deleted. */
const DOC_A = "doc-frd-a-2272";
const DOC_B = "doc-frd-b-2272";
const DOC_DELETED = "doc-frd-deleted-2272";
/** A repository's file, one still ingesting, and one with no text (all in ws-a). */
const DOC_REPO = "doc-repo-file-2272";
const DOC_PROCESSING = "doc-processing-2272";
const DOC_EMPTY = "doc-empty-2272";
const REQ_LONG = "req-long-2272";
const FRD = [
  "# Accounts FRD",
  "",
  "## Reset",
  "",
  `- ${RESET_CRITERIA[0]}`,
  `- ${RESET_CRITERIA[1]}`,
  "",
  "## Appendix",
  "",
  "Tables the model could not read.",
  "",
].join("\n");

/** The model's reading of {@link FRD}: both criteria, and the appendix unread. */
const READING: DocumentReading = {
  mode: "whole",
  statements: RESET_CRITERIA.map((statement, i) => ({
    id: `T${i + 1}`,
    kind: "requirement" as const,
    statement,
    quote: statement,
    start: 0,
    end: statement.length,
    sectionId: "S1",
    // No heading path: the criterion is the statement as the fixture index knows it.
    headingPath: [],
    refersTo: [],
  })),
  sections: [
    {
      sectionId: "S2",
      headingPath: ["Accounts FRD", "Appendix"],
      start: 0,
      end: 1,
      status: "unread",
      kinds: {},
      statements: 0,
      unverified: 0,
      repeats: 0,
    },
  ],
  droppedUnverified: 1,
  merge: "skipped",
  calls: 2,
  outputTokenCap: 1000,
  usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2272 — a portfolio check of a document's requirements, in chosen products",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let readerEnabled = true;
    let injectReader = true;
    const reader = vi.fn<PortfolioDocumentReader>(async () => ({
      reading: READING,
      costUsd: 0.05,
    }));

    const federated = new FederatedSearchService({ knowledgeService: fixtureKnowledgeService() });
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use(
        "/api/portfolio-assessments",
        portfolioAssessmentsRouter({
          gap: {
            get provider() {
              return scriptedProvider();
            },
            search: federated.searchAcrossProjects.bind(federated),
            limits: { runCostCapUsd: 100, productCostCapUsd: 100, concurrency: 2 },
            costOf: () => 0.01,
          },
          document: {
            storage: {
              read: async (path: string) =>
                Buffer.from(path.includes(DOC_EMPTY) ? "   " : FRD, "utf-8"),
            },
            readerEnabled: () => readerEnabled,
            get reader() {
              return injectReader ? reader : undefined;
            },
          },
        }),
      );
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const post = (who: Who, body: object) =>
      request(app())
        .post("/api/portfolio-assessments")
        .set("Authorization", bearer(who))
        .send(body);
    const get = (who: Who, path: string) =>
      request(app()).get(`/api/portfolio-assessments${path}`).set("Authorization", bearer(who));

    async function settled(id: string, who: Who): Promise<PortfolioAssessmentView> {
      for (let i = 0; i < 300; i++) {
        const row = await db.portfolioAssessment.findUnique({ where: { id } });
        if (row && row.status !== "pending" && row.status !== "running") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const res = await get(who, `/${id}`);
      expect(res.status).toBe(200);
      return res.body.data as PortfolioAssessmentView;
    }

    async function start(who: Who, body: object): Promise<string> {
      const res = await post(who, body);
      expect(res.status).toBe(202);
      return res.body.data.id as string;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2272-portfolio-document-check");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedPortfolio(db, USERS);
      for (const [id, projectId, deletedAt, source, status] of [
        [DOC_A, PROJECTS[0].id, null, "upload", "ready"],
        [DOC_B, PROJECTS[2].id, null, "upload", "ready"],
        [DOC_DELETED, PROJECTS[0].id, new Date("2026-11-01T00:00:00Z"), "upload", "ready"],
        [DOC_REPO, PROJECTS[0].id, null, "repo", "ready"],
        [DOC_PROCESSING, PROJECTS[0].id, null, "upload", "processing"],
        [DOC_EMPTY, PROJECTS[0].id, null, "upload", "ready"],
      ] as const) {
        await db.document.create({
          data: {
            id,
            projectId,
            filename: `${id}.md`,
            title: "Accounts FRD",
            mimeType: "text/markdown",
            sizeBytes: FRD.length,
            storagePath: `docs/${id}.md`,
            checksum: id,
            status,
            source,
            uploadedById: "mia",
            deletedAt,
          },
        });
      }
      const analysisId = "ana-req-long-2272";
      await db.analysis.create({
        data: {
          id: analysisId,
          projectId: PROJECTS[0].id,
          startedById: "mia",
          status: "completed",
        },
      });
      await db.requirement.create({
        data: {
          id: REQ_LONG,
          projectId: PROJECTS[0].id,
          analysisId,
          title: "A very long requirement",
          body: "x".repeat(PORTFOLIO_STATEMENT_MAX_CHARS + 500),
          acceptanceCriteria: JSON.stringify(RESET_CRITERIA),
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("checks each requirement the model read from the document, and lists what it could not read", async () => {
      readerEnabled = true;
      const id = await start("ana", { documentId: DOC_A, scope: "product", productIds: [P1, P2] });
      const view = await settled(id, "ana");
      expect(view.status).toBe("completed");
      expect(view.sourceDocumentId).toBe(DOC_A);
      expect(view.sourceProjectId).toBe(PROJECTS[0].id);
      expect(view.statement).toBe(
        'Requirements read from "Accounts FRD": the model read it in full and found 2 requirements. Each is checked on its own.',
      );
      // Several chosen products, each checked.
      expect(view.productIds).toEqual([P1, P2]);
      const accounts = view.products.find((p) => p.productId === P1)!;
      expect(accounts.coverage).toBe("covers");
      const criteria = (accounts.technicalDetail as { criteria: Array<{ criterion: string }> })
        .criteria;
      expect(criteria.map((c) => c.criterion)).toEqual(RESET_CRITERIA);
      expect(view.notChecked).toEqual([
        { text: "Accounts FRD › Appendix", reason: "section-unread", count: null },
        { text: "Statements the model read", reason: "quote-not-found", count: 1 },
      ]);
      // The reading's cost is the run's too.
      expect(view.costUsd).toBeGreaterThanOrEqual(0.05);
      // #2280 — with the stored document's key, so a saved reading of it is reused.
      expect(reader).toHaveBeenCalledWith({
        title: "Accounts FRD",
        text: FRD,
        document: { projectId: PROJECTS[0].id, documentId: DOC_A, checksum: DOC_A },
      });

      const md = await get("ana", `/${id}/export`);
      expect(md.status).toBe(200);
      expect(md.text).toContain("## Requirements checked");
      expect(md.text).toContain(`| 1 | ${RESET_CRITERIA[0]} | Accounts`);
      expect(md.text).toContain(
        "- Accounts FRD › Appendix: Not checked: the model could not read this section of the document.",
      );
      const stored = await db.portfolioAssessment.findUnique({ where: { id } });
      expect(JSON.parse(stored!.notChecked)).toEqual(view.notChecked);
      expect(stored!.sourceDocumentId).toBe(DOC_A);
      // A cited repo backs the requirement it covers.
      expect(view.repos.some((r) => r.repoConnectionId === RC_P1_API)).toBe(true);
    });

    it("with the reader off, the splitter's parts are checked, and the statement says so", async () => {
      readerEnabled = false;
      reader.mockClear();
      const id = await start("ana", { documentId: DOC_A, scope: "product", productIds: [P1] });
      const view = await settled(id, "ana");
      readerEnabled = true;
      expect(view.status).toBe("completed");
      expect(reader).not.toHaveBeenCalled();
      expect(view.statement).toContain("the splitter (one per paragraph or bullet");
      expect(view.notChecked).toEqual([]);
    });

    it("with the reader on and none injected, the gap engine's model reads it; a reply it cannot use falls back to the splitter", async () => {
      injectReader = false;
      const id = await start("ana", { documentId: DOC_A, scope: "product", productIds: [P1] });
      const view = await settled(id, "ana");
      injectReader = true;
      expect(view.status).toBe("completed");
      // The scripted model answers every prompt as a repo verdict: no reading can be made of it.
      expect(view.statement).toContain("the model could not read it, so the splitter");
    });

    it("only a reader of the document's project may read the check", async () => {
      const id = await start("mia", { documentId: DOC_A, scope: "all-accessible" });
      await settled(id, "mia");
      // Ola reads Billing (ws-b), which the check covered, but not the FRD's project.
      expect((await get("ola", `/${id}`)).status).toBe(404);
      expect((await get("ola", `/${id}/export`)).status).toBe(404);
    });

    it.each([
      ["a document in a project the caller cannot read", DOC_B],
      ["a deleted document", DOC_DELETED],
      ["an unknown document", "doc-unknown-2272"],
    ])("404 for %s, and nothing is started", async (_label, documentId) => {
      const before = await db.portfolioAssessment.count({ where: { createdById: "ana" } });
      const res = await post("ana", { documentId, scope: "all-accessible" });
      expect(res.status).toBe(404);
      expect(await db.portfolioAssessment.count({ where: { createdById: "ana" } })).toBe(before);
    });

    it.each([
      ["a repository's file", DOC_REPO, "DOCUMENT_NOT_CHECKABLE"],
      ["a document still processing", DOC_PROCESSING, "DOCUMENT_NOT_READY"],
    ])("400 for %s the caller can read, and nothing is started", async (_l, documentId, code) => {
      const before = await db.portfolioAssessment.count({ where: { createdById: "ana" } });
      const res = await post("ana", { documentId, scope: "all-accessible" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(code);
      expect(await db.portfolioAssessment.count({ where: { createdById: "ana" } })).toBe(before);
      // Who cannot read the project still gets the 404: no existence oracle.
      expect((await post("ola", { documentId, scope: "all-accessible" })).status).toBe(404);
    });

    it("a document with no requirement fails the check and says why, on the page and in the export", async () => {
      const id = await start("ana", { documentId: DOC_EMPTY, scope: "product", productIds: [P1] });
      const view = await settled(id, "ana");
      expect(view.status).toBe("failed");
      expect(view.statement).toBe(
        'Requirements read from "Accounts FRD": The document has no text to read.',
      );
      const md = await get("ana", `/${id}/export`);
      expect(md.text).toContain("The document has no text to read.");
    });

    it("a stored not-checked entry that does not read as one is dropped, never shown in part", async () => {
      const id = await start("ana", {
        statement: "Password reset by email",
        scope: "product",
        productIds: [P1],
      });
      await settled(id, "ana");
      const good = { text: "Appendix", reason: "section-unread", count: null };
      await db.portfolioAssessment.update({
        where: { id },
        data: {
          notChecked: JSON.stringify([
            good,
            { text: "Bogus", reason: "not-a-reason", count: null },
            { text: "Extra key", reason: "budget", count: 1, secret: "x" },
            { text: "Negative", reason: "budget", count: -1 },
            "just a string",
          ]),
        },
      });
      const view = await settled(id, "ana");
      expect(view.notChecked).toEqual([good]);
      const md = await get("ana", `/${id}/export`);
      expect(md.text).toContain("Appendix");
      expect(md.text).not.toContain("Bogus");
      expect(md.text).not.toContain("Extra key");
    });

    it("a requirement's text past what one check reads is listed as cut, not cut silently", async () => {
      const id = await start("ana", {
        requirementId: REQ_LONG,
        scope: "product",
        productIds: [P1],
      });
      const view = await settled(id, "ana");
      expect(view.status).toBe("completed");
      expect(view.statement).toHaveLength(PORTFOLIO_STATEMENT_MAX_CHARS);
      expect(view.notChecked).toEqual([
        {
          text: expect.stringMatching(/^A very long requirement x+…$/),
          reason: "text-cut",
          count: "A very long requirement\n\n".length + 500,
        },
      ]);
    });

    it("hosts the requirement on one of several chosen products", async () => {
      const id = await start("ana", {
        statement: "Password reset by email",
        scope: "product",
        productIds: [P1, P2],
        hostProductId: P2,
      });
      const view = await settled(id, "ana");
      expect(view.status).toBe("completed");
      expect(view.hostProductId).toBe(P2);
      expect(view.products.find((p) => p.productId === P2)?.impactKind).toBe("direct-change");
    });
  },
);
