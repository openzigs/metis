/**
 * Issue #1837 — the similar and duplicate requirement API, end to end: real
 * routes, real `requireProjectAccess`, a migrated SQLite database, the local
 * vector store, and the REAL embedder's vectors for #1836's fixture pairs,
 * replayed from `__fixtures__/pairs-recorded.json` so the committed thresholds
 * label real cosines (re-record with `pnpm --filter @metis/server
 * eval:req-similarity --record-vectors <ids>`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SIMILAR_CODE_LINKS_PER_ITEM, type SimilarRequirementItem } from "@metis/shared";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(
  here,
  "..",
  "src",
  "lib",
  "eval",
  "requirement-similarity",
  "__fixtures__",
);

const state = vi.hoisted(() => {
  process.env.VECTOR_STORE = "local";
  return {
    db: null as unknown,
    embed: null as null | { model: string; embed: (t: string[]) => Promise<unknown> },
    providerChat: vi.fn(),
    resolveProvider: vi.fn(),
    warn: vi.fn(),
  };
});
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/rag/embedder.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => state.embed,
}));
vi.mock("../src/lib/ai/project-provider.js", () => ({
  resolveProjectProvider: state.resolveProvider,
}));

const { requirementSimilarityRouter } = await import("../src/routes/requirement-similarity.js");
const { findSimilarRequirements } = await import("../src/lib/requirements/similar-requirements.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { __resetVectorStoreSingleton, getVectorStore } =
  await import("../src/lib/rag/vector-store.js");
const { loadRecordedVectors, RecordedEmbedService } =
  await import("../src/lib/eval/recorded-vectors.js");
const { loadRequirementPairs } =
  await import("../src/lib/eval/requirement-similarity/calibration.js");

const WS_A = "ws-1837-a";
const WS_B = "ws-1837-b";
const A = "p-1837-a";
const B = "p-1837-b";
const MEMBER = "u-1837-member";
const OUTSIDER = "u-1837-outsider";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1837 — similar requirements API",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let lanceRoot: string;
    let memberToken = "";
    let outsiderToken = "";
    const ids: Record<string, string> = {};

    const app = () => {
      const a = express();
      a.use(express.json({ limit: "1mb" }));
      a.use("/api/projects/:projectId/requirements", requirementSimilarityRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (project: string, requirementId: string, token = memberToken) =>
      request(app())
        .get(`/api/projects/${project}/requirements/${requirementId}/similar`)
        .set("Authorization", `Bearer ${token}`);
    const post = (project: string, body: unknown, token = memberToken) =>
      request(app())
        .post(`/api/projects/${project}/requirements/similar`)
        .set("Authorization", `Bearer ${token}`)
        .send(body as object);

    beforeAll(async () => {
      lanceRoot = mkdtempSync(path.join(os.tmpdir(), "metis-1837-"));
      process.env.LANCEDB_PATH = lanceRoot;
      __resetVectorStoreSingleton();
      const recording = await loadRecordedVectors(path.join(FIXTURE_DIR, "pairs-recorded.json"));
      if (!recording) throw new Error("pairs-recorded.json is missing");
      const recorded = new RecordedEmbedService(recording, "eval:req-similarity --record-vectors");
      state.embed = { model: recording.model, embed: (t) => recorded.embed(t) };

      sqlite = createMigratedSqlite("1837-similar-requirements");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      const role = await db.role.upsert({
        where: { key: "coordinator" },
        update: {},
        create: { key: "coordinator", name: "coordinator", isSystem: true },
      });
      for (const [ws, user] of [
        [WS_A, MEMBER],
        [WS_B, OUTSIDER],
      ] as const) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        await db.user.create({
          data: { id: user, username: user, displayName: user, email: `${user}@example.test` },
        });
        await db.userRole.create({ data: { userId: user, roleId: role.id, source: "local" } });
        await db.workspaceMember.create({
          data: { workspaceId: ws, userId: user, role: "member" },
        });
      }
      for (const [project, ws, owner] of [
        [A, WS_A, MEMBER],
        [B, WS_B, OUTSIDER],
      ] as const) {
        await db.project.create({
          data: { id: project, name: project, slug: project, createdById: owner, workspaceId: ws },
        });
        await db.analysis.create({
          data: { id: `a-${project}`, projectId: project, startedById: owner, status: "completed" },
        });
      }
      const token = (userId: string, ws: string) =>
        issueTokens({
          userId,
          username: userId,
          role: "coordinator",
          permissions: [],
          workspaces: [ws],
        }).accessToken;
      memberToken = token(MEMBER, WS_A);
      outsiderToken = token(OUTSIDER, WS_B);

      const pairs = new Map(
        (await loadRequirementPairs(path.join(FIXTURE_DIR, "pairs.json"))).map((p) => [p.id, p]),
      );
      const add = async (
        key: string,
        project: string,
        req: { title: string; body: string },
        extra: Record<string, unknown> = {},
      ) => {
        const row = await db.requirement.create({
          data: {
            projectId: project,
            analysisId: `a-${project}`,
            title: req.title,
            body: req.body,
            ...extra,
          },
        });
        ids[key] = row.id;
      };
      const p = (id: string) => pairs.get(id)!;
      await add("batch", A, p("wh-rel-05").a);
      await add("lot", A, p("wh-dup-05").b, {
        reviewStatus: "approved",
        promotedStructuredId: "REQ-007",
      });
      await add("serial", A, p("wh-rel-05").b);
      await add("recall", A, p("wh-ovl-04").b);
      await add("holiday", A, p("wh-unr-05").b);
      await add("pdf", A, p("inv-rel-01").b);
      await add("password", A, p("inv-unr-01").b);
      await add("lotInB", B, p("wh-dup-05").b);
      for (const [filePath, confidence] of [
        ["src/inventory/lots.ts", 0.9],
        ["src/inventory/recall.ts", 0.6],
      ] as const) {
        await db.requirementCodeMapping.create({
          data: {
            requirementId: ids.lot,
            projectId: A,
            filePath,
            startLine: 10,
            endLine: 40,
            confidence,
          },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      delete process.env.REQ_SIMILARITY_VERIFIER;
      state.providerChat.mockReset();
      state.resolveProvider.mockReset();
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      rmSync(lanceRoot, { recursive: true, force: true });
    });

    it("lists a requirement's similar requirements, labelled by the committed thresholds, never itself", async () => {
      const res = await get(A, ids.batch);
      expect(res.status).toBe(200);
      const items = res.body.data.items as Array<Record<string, unknown>>;
      const byId = new Map(items.map((i) => [i.requirementId, i]));
      expect(byId.has(ids.batch)).toBe(false);
      // wh-dup-05 (cosine 0.884): a duplicate, with its key, status and saved links.
      expect(items[0]).toMatchObject({
        requirementId: ids.lot,
        analysisId: `a-${A}`,
        notDuplicate: false,
        linkedAsDuplicate: false,
        key: "REQ-007",
        status: "approved",
        label: "duplicate",
        codeLinks: [
          {
            filePath: "src/inventory/lots.ts",
            startLine: 10,
            endLine: 40,
            source: "semantic",
            freshness: "unverified",
          },
          { filePath: "src/inventory/recall.ts", freshness: "unverified" },
        ],
      });
      // The hard-negative pair wh-rel-05 (batch vs serial numbers, 0.752): related, not duplicate.
      expect(byId.get(ids.serial)).toMatchObject({
        label: "related",
        status: "draft",
        codeLinks: [],
      });
      // wh-unr-05 (0.526) is below the floor: not similar at all.
      expect(byId.has(ids.holiday)).toBe(false);
      // Project B's identical requirement never appears.
      expect(byId.has(ids.lotInB)).toBe(false);
    });

    it("answers 404 to a caller without access, and to another project's requirement id", async () => {
      expect((await get(A, ids.batch, outsiderToken)).status).toBe(404);
      expect((await post(A, { text: "Track batch numbers" }, outsiderToken)).status).toBe(404);
      const crossed = await get(A, ids.lotInB);
      expect(crossed.status).toBe(404);
      expect(crossed.body.data).toBeUndefined();
    });

    it("finds draft text's neighbours, and makes no model call with the verifier off", async () => {
      const res = await post(A, {
        text: "Export invoices to CSV\n\nAs a finance clerk I want to export the month's invoices to a CSV file so that I can load them into the accounting system.",
      });
      expect(res.status).toBe(200);
      // inv-rel-01 (CSV vs PDF, 0.881) is a hard negative the threshold alone calls a duplicate.
      expect(res.body.data.items[0]).toMatchObject({ requirementId: ids.pdf, label: "duplicate" });
      expect(state.resolveProvider).not.toHaveBeenCalled();
    });

    it("with the verifier on, relabels from the model's answer", async () => {
      process.env.REQ_SIMILARITY_VERIFIER = "1";
      state.resolveProvider.mockResolvedValue({ chat: state.providerChat });
      state.providerChat.mockImplementation(async (messages: Array<{ content: string }>) => {
        const count = (messages[1]!.content.match(/^\[\d+\]$/gm) ?? []).length;
        return {
          content: JSON.stringify({
            labels: Array.from({ length: count }, (_, index) => ({ index, label: "related" })),
          }),
        };
      });
      const res = await get(A, ids.batch);
      expect(res.status).toBe(200);
      expect(state.resolveProvider).toHaveBeenCalledWith(A);
      expect(
        res.body.data.items.find((i: { requirementId: string }) => i.requirementId === ids.lot),
      ).toMatchObject({
        label: "related",
      });
    });

    it("with the verifier on, a malformed reply or a provider failure falls back to the threshold labels", async () => {
      process.env.REQ_SIMILARITY_VERIFIER = "1";
      state.resolveProvider.mockResolvedValue({ chat: state.providerChat });
      state.providerChat.mockResolvedValueOnce({ content: "I think they are all duplicates." });
      const malformed = await get(A, ids.batch);
      expect(malformed.status).toBe(200);
      expect(malformed.body.data.items[0]).toMatchObject({
        requirementId: ids.lot,
        label: "duplicate",
      });

      state.providerChat.mockRejectedValueOnce(new Error("upstream 529"));
      const failed = await get(A, ids.batch);
      expect(failed.status).toBe(200);
      expect(failed.body.data.items[0]).toMatchObject({ label: "duplicate" });

      state.resolveProvider.mockRejectedValueOnce(new Error("no credentials"));
      const unavailable = await get(A, ids.batch);
      expect(unavailable.status).toBe(200);
      expect(unavailable.body.data.items[0]).toMatchObject({ label: "duplicate" });
    });

    it("validates the draft body and the limit", async () => {
      expect((await post(A, { text: "x".repeat(8_001) })).status).toBe(400);
      expect((await post(A, {})).status).toBe(400);
      expect((await post(A, { text: "ok", extra: true })).status).toBe(400);
      expect((await post(A, { text: "ok", acceptanceCriteria: Array(31).fill("c") })).status).toBe(
        400,
      );
      expect((await get(A, ids.batch).query({ limit: 0 })).status).toBe(400);
      const one = await request(app())
        .get(`/api/projects/${A}/requirements/${ids.batch}/similar?limit=1`)
        .set("Authorization", `Bearer ${memberToken}`);
      expect(one.status).toBe(200);
      expect(one.body.data.items).toHaveLength(1);
    });

    it("a candidate only BM25 finds is scored by a cosine computed for it", async () => {
      // A vector store that returns nothing: every candidate arrives through BM25,
      // and each is labelled from the cosine of the recorded vectors.
      const blind = new Proxy(getVectorStore(), {
        get(target, prop, receiver) {
          if (prop === "search") return async () => [];
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const items = await findSimilarRequirements(
        A,
        { requirementId: ids.batch },
        { store: blind, limit: 10 },
      );
      expect(items.find((i) => i.requirementId === ids.lot)).toMatchObject({ label: "duplicate" });
      expect(items.find((i) => i.requirementId === ids.serial)).toMatchObject({ label: "related" });
      expect(items.find((i) => i.requirementId === ids.serial)?.score).toBeCloseTo(0.752, 2);
    });

    it("passes a stamped link's freshness through (#1830), and reads anything else as unverified", async () => {
      const stamped = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "requirementCodeMapping")
            return Reflect.get(target, prop, receiver) as unknown;
          return {
            findMany: async (args: Parameters<typeof db.requirementCodeMapping.findMany>[0]) =>
              (await target.requirementCodeMapping.findMany(args)).map((m, i) => ({
                ...m,
                freshness: i === 0 ? "stale" : "bogus",
              })),
          };
        },
      });
      const [lot] = await findSimilarRequirements(
        A,
        { requirementId: ids.batch },
        { db: stamped, limit: 1 },
      );
      expect(lot?.codeLinks.map((l) => l.freshness)).toEqual(["stale", "unverified"]);
    });

    it("#1840 — each code link carries its saved row's id, for the borrow to name", async () => {
      const [lot] = await findSimilarRequirements(
        A,
        { requirementId: ids.batch },
        { db, limit: 1 },
      );
      const rows = await db.requirementCodeMapping.findMany({
        where: { requirementId: lot!.requirementId },
        select: { id: true, filePath: true },
      });
      expect(lot!.codeLinks.length).toBeGreaterThan(0);
      for (const l of lot!.codeLinks) {
        expect(rows.find((r) => r.id === l.mappingId)?.filePath).toBe(l.filePath);
      }
    });

    it("#1902 — a link the similar requirement borrowed itself arrives labelled, so the panel counts it apart", async () => {
      const borrowed = await db.requirementCodeMapping.create({
        data: {
          requirementId: ids.lot,
          projectId: A,
          filePath: "src/inventory/borrowed.ts",
          startLine: 1,
          endLine: 5,
          confidence: 0.4,
          source: "similar-requirement",
          originRequirementId: ids.serial,
          freshness: "fresh",
        },
      });
      try {
        const [lot] = await findSimilarRequirements(
          A,
          { requirementId: ids.batch },
          { db, limit: 1 },
        );
        expect(lot!.codeLinks.map((l) => [l.filePath, l.source])).toEqual([
          ["src/inventory/lots.ts", "semantic"],
          ["src/inventory/recall.ts", "semantic"],
          ["src/inventory/borrowed.ts", "similar-requirement"],
        ]);
      } finally {
        await db.requirementCodeMapping.delete({ where: { id: borrowed.id } });
      }
    });

    it("#1931 — says when it holds more code links than the cap returns, and not at the cap", async () => {
      const [first] = await findSimilarRequirements(
        A,
        { requirementId: ids.batch },
        { db, limit: 1 },
      );
      expect(first).toMatchObject({ requirementId: ids.lot, codeLinksTruncated: false });
      // lot holds 2 links: 18 more reach the cap exactly, one past it truncates.
      const extra = (n: number, from: number) =>
        Array.from({ length: n }, (_, i) => ({
          requirementId: ids.lot!,
          projectId: A,
          filePath: `src/inventory/extra-${from + i}.ts`,
          confidence: 0.1,
        }));
      await db.requirementCodeMapping.createMany({
        data: extra(SIMILAR_CODE_LINKS_PER_ITEM - 2, 0),
      });
      try {
        const [atCap] = await findSimilarRequirements(
          A,
          { requirementId: ids.batch },
          { db, limit: 1 },
        );
        expect(atCap!.codeLinks).toHaveLength(SIMILAR_CODE_LINKS_PER_ITEM);
        expect(atCap!.codeLinksTruncated).toBe(false);

        await db.requirementCodeMapping.createMany({ data: extra(1, 100) });
        const res = await get(A, ids.batch);
        const lot = (res.body.data.items as SimilarRequirementItem[]).find(
          (i) => i.requirementId === ids.lot,
        );
        expect(lot!.codeLinks).toHaveLength(SIMILAR_CODE_LINKS_PER_ITEM);
        expect(lot!.codeLinksTruncated).toBe(true);
      } finally {
        await db.requirementCodeMapping.deleteMany({
          where: { requirementId: ids.lot, filePath: { startsWith: "src/inventory/extra-" } },
        });
      }
    });

    it("#1838 — 'Not a duplicate' is remembered for the pair, read back through the API from either card", async () => {
      const mark = (project: string, a: string, b: string, token = memberToken) =>
        request(app())
          .post(`/api/projects/${project}/requirements/${a}/similar/${b}/not-duplicate`)
          .set("Authorization", `Bearer ${token}`);
      expect((await mark(A, ids.batch, ids.lot)).status).toBe(200);
      // Idempotent.
      expect((await mark(A, ids.batch, ids.lot)).status).toBe(200);
      const fromBatch = (await get(A, ids.batch)).body.data.items as Array<Record<string, unknown>>;
      expect(fromBatch.find((i) => i.requirementId === ids.lot)).toMatchObject({
        label: "duplicate",
        notDuplicate: true,
      });
      const fromLot = (await get(A, ids.lot)).body.data.items as Array<Record<string, unknown>>;
      expect(fromLot.find((i) => i.requirementId === ids.batch)).toMatchObject({
        notDuplicate: true,
      });
      // Another pair is untouched.
      expect(fromBatch.find((i) => i.requirementId === ids.serial)).toMatchObject({
        notDuplicate: false,
      });
      expect(await db.requirementSimilarityDismissal.count()).toBe(1);

      // Refused: the same requirement, another project's requirement, a caller without access.
      expect((await mark(A, ids.batch, ids.batch)).status).toBe(400);
      expect((await mark(A, ids.batch, ids.lotInB)).status).toBe(404);
      expect((await mark(A, ids.batch, ids.serial, outsiderToken)).status).toBe(404);
      expect(await db.requirementSimilarityDismissal.count()).toBe(1);
    });

    it("#1838 — a 'duplicates' link in either direction is reported as linkedAsDuplicate", async () => {
      await db.requirementLink.create({
        data: {
          sourceRequirementId: ids.serial,
          targetRequirementId: ids.batch,
          type: "duplicates",
          createdById: MEMBER,
        },
      });
      const items = (await get(A, ids.batch)).body.data.items as Array<Record<string, unknown>>;
      expect(items.find((i) => i.requirementId === ids.serial)).toMatchObject({
        linkedAsDuplicate: true,
      });
      expect(items.find((i) => i.requirementId === ids.lot)).toMatchObject({
        linkedAsDuplicate: false,
      });
      // Draft text has no pair: nothing is ever dismissed or linked.
      const draft = await post(A, {
        text: "Export invoices to CSV\n\nAs a finance clerk I want to export the month's invoices to a CSV file so that I can load them into the accounting system.",
      });
      expect(draft.status).toBe(200);
      expect(draft.body.data.items.length).toBeGreaterThan(0);
      for (const i of draft.body.data.items as Array<Record<string, unknown>>) {
        expect(i).toMatchObject({ notDuplicate: false, linkedAsDuplicate: false });
      }
    });
  },
);
