/**
 * #2280 — the saved document reading against a real SQLite database from the
 * migration chain: the real loader, the real reader (answering a scripted,
 * counting provider) and the real table.
 *
 *   - a second Requirements Analysis reading of an unchanged document calls no
 *     model and finds the same requirements; a new file (checksum) reads again;
 *   - "Read the document again" reads it and replaces the saved reading;
 *   - access is unchanged: a user in another workspace gets the impact route's
 *     404 for the document even though its reading is saved, the run never
 *     starts, and a Requirements Analysis in their own project cannot load it,
 *     so its reading is never looked up; a lookup under another project misses;
 *   - deleting the document (`KnowledgeService.deleteDocument`, a soft delete)
 *     deletes its saved readings.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../src/lib/ai/types.js";
import type { StorageBackend } from "../src/lib/documents/storage.js";
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
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
const triggerSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/impact-analysis/impact-analysis-engine.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/impact-analysis/impact-analysis-engine.js")
  >("../src/lib/impact-analysis/impact-analysis-engine.js");
  return { ...actual, triggerImpactAnalysis: triggerSpy };
});

const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { createReaderDocumentLoader, runDocumentReaderAgent } =
  await import("../src/lib/analysis/document-reader-agent.js");
const { readDocumentOnce } = await import("../src/lib/document-reader/reading-cache.js");
const { KnowledgeService } = await import("../src/lib/rag/knowledge-service.js");

const WS_A = "ws-a-2280";
const WS_M = "ws-m-2280";
const PA = "proj-a-2280";
const PM = "proj-m-2280";
const USERS: Record<string, { role: RoleKey; ws: string }> = {
  alice: { role: "coordinator", ws: WS_A },
  mallory: { role: "coordinator", ws: WS_M },
};
type Who = keyof typeof USERS;

const FRD = [
  "# Grants FRD",
  "",
  "## 1 Eligibility",
  "",
  "An applicant must be a registered charity in the county.",
  "",
  "## 2 Payment",
  "",
  "Grants over 5,000 pounds shall be paid in two instalments.",
  "",
].join("\n");

const READ_REPLY = JSON.stringify({
  statements: [
    {
      section: "S2",
      kind: "requirement",
      statement: "Applicants are registered county charities.",
      quote: "An applicant must be a registered charity in the county.",
    },
    {
      section: "S3",
      kind: "business-rule",
      statement: "Large grants are paid in two instalments.",
      quote: "Grants over 5,000 pounds shall be paid in two instalments.",
    },
  ],
});

/** The reader's provider, counting its calls. */
function countingProvider(): { provider: AIProvider; calls: () => number } {
  let calls = 0;
  const provider = {
    key: "anthropic",
    model: "claude-sonnet-5-5",
    offline: false,
    async chat(_m: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
      calls++;
      return {
        content: (opts?.systemMessage ?? "").includes("combining the statements")
          ? JSON.stringify({ duplicates: [], crossReferences: [] })
          : READ_REPLY,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        usage: { promptTokens: 1500, completionTokens: 200, totalTokens: 1700 },
      };
    },
  } as unknown as AIProvider;
  return { provider, calls: () => calls };
}

const files: Record<string, string> = {};
const storage = {
  async read(path: string) {
    const f = files[path];
    if (f === undefined) throw new Error("missing");
    return Buffer.from(f, "utf8");
  },
  async remove(path: string) {
    delete files[path];
  },
} as unknown as StorageBackend;

type Output = { requirements: Array<{ id: string; text: string; source: unknown }> };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2280 — a document's saved reading, on the real table",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let docA = "";

    const bearer = (who: Who) => {
      const payload: AuthPayload = {
        userId: who,
        username: who,
        role: USERS[who]!.role,
        permissions: getPermissionsForRole(USERS[who]!.role),
        workspaces: [USERS[who]!.ws],
      };
      return `Bearer ${issueTokens(payload).accessToken}`;
    };
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const analyse = (provider: AIProvider, projectId: string, reread = false) =>
      runDocumentReaderAgent({
        provider,
        projectId,
        documentIds: [docA],
        // #2262 — the requester; the document is unrestricted, so a member sees it.
        actor: { userId: "alice", role: "member" },
        load: createReaderDocumentLoader(storage),
        ...(reread ? { reread: true } : {}),
      });
    const saved = () => db.savedDocumentReading.findMany({ where: { documentId: docA } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2280-document-reading-cache");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.role.create({ data: { id: "role-coordinator", key: "coordinator", name: "c" } });
      for (const [id, u] of Object.entries(USERS)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.userRole.create({ data: { userId: id, roleId: `role-${u.role}` } });
        await db.workspace.create({ data: { id: u.ws, name: u.ws, slug: u.ws } });
        await db.workspaceMember.create({
          data: { workspaceId: u.ws, userId: id, role: "member" },
        });
      }
      for (const [id, createdById, workspaceId] of [
        [PA, "alice", WS_A],
        [PM, "mallory", WS_M],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
        });
      }
      files["pa/frd.md"] = FRD;
      docA = (
        await db.document.create({
          data: {
            projectId: PA,
            filename: "frd.md",
            mimeType: "text/markdown",
            sizeBytes: FRD.length,
            storagePath: "pa/frd.md",
            checksum: "sum-v1",
            uploadedById: "alice",
            status: "ready",
            indexState: "indexed",
          },
        })
      ).id;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => triggerSpy.mockReset());

    it("a second reading of the unchanged document calls no model and finds the same requirements", async () => {
      const model = countingProvider();
      const first = await analyse(model.provider, PA);
      expect(model.calls()).toBe(2);
      expect(await saved()).toEqual([
        expect.objectContaining({ projectId: PA, checksum: "sum-v1", model: "claude-sonnet-5-5" }),
      ]);

      const second = await analyse(model.provider, PA);
      expect(model.calls()).toBe(2);
      expect(second!.result.usage.totalTokens).toBe(0);
      expect((second!.result.output as unknown as Output).requirements).toEqual(
        (first!.result.output as unknown as Output).requirements,
      );
      expect(second!.coverage.documents[0]!.reused).toMatchObject({ model: "claude-sonnet-5-5" });
    });

    it('"Read the document again" reads it and replaces the saved reading; a new file reads again', async () => {
      const model = countingProvider();
      const before = (await saved())[0]!;
      await analyse(model.provider, PA, true);
      expect(model.calls()).toBe(2);
      const after = await saved();
      expect(after).toHaveLength(1);
      expect(after[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(before.createdAt.getTime());

      await db.document.update({ where: { id: docA }, data: { checksum: "sum-v2" } });
      await analyse(model.provider, PA);
      expect(model.calls()).toBe(4);
      expect((await saved()).map((r) => r.checksum).sort()).toEqual(["sum-v1", "sum-v2"]);
    });

    it("a user in another workspace cannot reach the saved reading: the impact route refuses, and their own project cannot load it", async () => {
      expect((await saved()).length).toBeGreaterThan(0);
      for (const body of [
        { documentId: docA, projectIds: [PM] },
        { documentId: docA, projectIds: [PM], rereadDocument: false },
      ]) {
        const res = await request(app())
          .post("/api/impact-analyses")
          .set("Authorization", bearer("mallory"))
          .send(body);
        expect(res.status).toBe(404);
      }
      expect(triggerSpy).not.toHaveBeenCalled();

      // Requirements Analysis in mallory's project naming alice's document: not loaded, not looked up.
      const model = countingProvider();
      const findFirst = vi.spyOn(db.savedDocumentReading, "findFirst");
      expect(await analyse(model.provider, PM)).toBeNull();
      expect(model.calls()).toBe(0);
      expect(findFirst).not.toHaveBeenCalled();
      findFirst.mockRestore();

      // And a lookup under another project misses: the key alone is not enough.
      const read = await readDocumentOnce({
        title: "frd.md",
        text: FRD,
        provider: model.provider,
        document: { projectId: PM, documentId: docA, checksum: "sum-v2" },
      });
      expect(read.reused).toBeUndefined();
      expect(model.calls()).toBe(2);
    });

    it("the alice-started run on the same document reaches the engine", async () => {
      triggerSpy.mockResolvedValue({ id: "ia-1", status: "pending" });
      const res = await request(app())
        .post("/api/impact-analyses")
        .set("Authorization", bearer("alice"))
        .send({ documentId: docA, projectIds: [PA], rereadDocument: true });
      expect(res.status).toBe(202);
      expect(triggerSpy).toHaveBeenCalledTimes(1);
    });

    it("deleting the document deletes its saved readings", async () => {
      expect((await saved()).length).toBeGreaterThan(0);
      const svc = new KnowledgeService({
        storage,
        vectorStore: { deleteByDocument: vi.fn(async () => undefined) },
        bm25: { removeDocument: vi.fn(async () => undefined) },
      } as never);
      await svc.deleteDocument(docA);
      expect(await saved()).toEqual([]);
      expect((await db.document.findUnique({ where: { id: docA } }))?.deletedAt).toBeInstanceOf(
        Date,
      );
    });
  },
);
