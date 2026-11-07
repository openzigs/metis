/**
 * Epic #1866 (#1869) — workspace governing documents through the REAL routes,
 * over a REAL SQLite database (the real migration chain) and the real local
 * vector store on disk. Only the caller (the auth middleware), the audit sink and
 * the embedder (a deterministic bag-of-words) are doubles.
 *
 * Every assertion reads back through a path a consumer uses: a fresh HTTP
 * request, and a fresh `GoverningIndex` over a fresh store instance (no cache
 * shared with the upload), so a write the read cannot see fails here.
 *
 * Two workspaces, A and B, each hold a governing document for the isolation
 * tests: both fixtures are present whenever a cross-workspace read is refused.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DOCUMENT_BYTES } from "@metis/shared";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.UPLOAD_RATE_LIMIT_MAX = "100000";
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// The caller: `x-test-user` names one of USERS.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const who = String(req.headers["x-test-user"] ?? "");
    const user = (globalThis as unknown as { __users1869: Record<string, unknown> }).__users1869[
      who
    ];
    if (!user) {
      next(Object.assign(new Error("no user"), { statusCode: 401 }));
      return;
    }
    (req as unknown as { user: unknown }).user = user;
    next();
  },
}));

// The vector root is read when the first store is built, after this line.
const vectorTmp = mkdtempSync(path.join(os.tmpdir(), "metis-1869-"));
process.env.LANCEDB_PATH = path.join(vectorTmp, "vectors");

const { governingDocumentsRouter, governingStorageKey } =
  await import("../src/routes/governing-documents.js");
const { GoverningIndex } = await import("../src/lib/governing/governing-index.js");
const { reindexGoverningRevisions } = await import("../src/lib/governing/governing-reindex.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { DocumentStorage } = await import("../src/lib/documents/storage.js");
const { validateUpload } = await import("../src/lib/documents/upload.js");
const { KnowledgeService } = await import("../src/lib/rag/knowledge-service.js");
const { BM25Index } = await import("../src/lib/rag/bm25-index.js");
const { getVectorStore, __resetVectorStoreSingleton, GOVERNING_VECTOR_NAMESPACE } =
  await import("../src/lib/rag/vector-store.js");
type Embedder = import("../src/lib/rag/embedder.js").Embedder;

// ── A deterministic embedder: hashed bag of words, unit length ──────────────
const DIM = 64;
function bow(text: string, dim = DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % dim] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
function bowEmbedder(model: string, dim: number) {
  return {
    model,
    dimension: dim,
    embed: async (texts: string[]) => ({
      vectors: texts.map((t) => bow(t, dim)),
      model,
      dimension: dim,
    }),
  };
}
const embedder = bowEmbedder("test-bow", DIM);

// ── Who is calling ───────────────────────────────────────────────────────────
const ID = {
  adminA: "u-admin-a",
  memberA: "u-member-a",
  adminB: "u-admin-b",
  sysadmin: "u-sysadmin",
  wsA: "wsa1869",
  wsB: "wsb1869",
  wsGone: "wsgone1869",
  projectA: "pa1869",
};
const USERS: Record<string, unknown> = {
  adminA: { userId: ID.adminA, username: "admin-a", role: "developer", permissions: [] },
  memberA: { userId: ID.memberA, username: "member-a", role: "developer", permissions: [] },
  adminB: { userId: ID.adminB, username: "admin-b", role: "developer", permissions: [] },
  sysadmin: { userId: ID.sysadmin, username: "root", role: "admin", permissions: [] },
};
(globalThis as unknown as { __users1869: Record<string, unknown> }).__users1869 = USERS;

const POLICY_V1 = [
  "# Access control policy",
  "",
  "## 4.3 Password rotation",
  "",
  "Every service account password must be rotated every ninety days by its owner.",
].join("\n");
const POLICY_V2 = POLICY_V1.replace("every ninety days", "every thirty days");
const B_POLICY = [
  "# Vendor policy",
  "",
  "Every vendor contract must be reviewed by legal counsel before signature.",
].join("\n");

const base = (ws: string) => `/api/workspaces/${ws}/governing-documents`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1869 — workspace governing documents (real SQLite, real vector store)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let uploadsRoot: string;
    let docB: { documentId: string; revisionId: string };

    function app(index = new GoverningIndex({ embedder })) {
      const a = express();
      a.use(express.json());
      a.use(
        "/api/workspaces/:workspaceId/governing-documents",
        governingDocumentsRouter({
          storage: new DocumentStorage({ root: uploadsRoot }),
          index,
          // #1870's rule extraction is covered by governing-rules.extraction.sqlite.test.ts;
          // here it would run in the background against the offline stub.
          extractRules: async () => undefined,
        }),
      );
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    }

    function upload(
      who: string,
      ws: string,
      opts: {
        body?: string | Buffer;
        filename?: string;
        contentType?: string;
        fields?: Record<string, string>;
        path?: string;
        a?: express.Express;
      } = {},
    ) {
      const fields = opts.fields ?? {
        title: "Access control policy",
        revisionLabel: "v1",
        effectiveDate: "2026-01-01",
        framework: "Internal security policy",
      };
      let req = request(opts.a ?? app())
        .post(opts.path ?? base(ws))
        .set("x-test-user", who);
      for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
      return req.attach(
        "file",
        Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body ?? POLICY_V1, "utf8"),
        {
          filename: opts.filename ?? "policy.md",
          contentType: opts.contentType ?? "text/markdown",
        },
      );
    }

    /** A fresh index over a fresh store instance: nothing cached from the write. */
    function freshIndex(e: typeof embedder = embedder) {
      __resetVectorStoreSingleton();
      return new GoverningIndex({ embedder: e });
    }

    const actor = (who: keyof typeof ID) => ({
      id: ID[who],
      role: (USERS[who] as { role: string }).role,
    });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1869-governing");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      uploadsRoot = mkdtempSync(path.join(os.tmpdir(), "metis-1869-uploads-"));
      for (const [key, id] of Object.entries({
        adminA: ID.adminA,
        memberA: ID.memberA,
        adminB: ID.adminB,
        sysadmin: ID.sysadmin,
      })) {
        await db.user.create({
          data: { id, username: key, displayName: key, email: `${key}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: ID.wsA, name: "A", slug: "a-1869" } });
      await db.workspace.create({ data: { id: ID.wsB, name: "B", slug: "b-1869" } });
      await db.workspace.create({
        data: { id: ID.wsGone, name: "Gone", slug: "gone-1869" },
      });
      await db.workspaceMember.createMany({
        data: [
          { workspaceId: ID.wsA, userId: ID.adminA, role: "admin" },
          { workspaceId: ID.wsA, userId: ID.memberA, role: "member" },
          { workspaceId: ID.wsB, userId: ID.adminB, role: "owner" },
          { workspaceId: ID.wsGone, userId: ID.adminA, role: "admin" },
        ],
      });
      await db.project.create({
        data: {
          id: ID.projectA,
          name: "Project A",
          slug: "pa-1869",
          workspaceId: ID.wsA,
          createdById: ID.adminA,
        },
      });
      process.env.GOVERNING_DOCS_ENABLED = "1";
      const res = await upload("adminB", ID.wsB, {
        body: B_POLICY,
        fields: { title: "Vendor policy", revisionLabel: "2026", effectiveDate: "2026-02-01" },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      docB = res.body.data;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      delete process.env.GOVERNING_DOCS_ENABLED;
      await db?.$disconnect();
      sqlite?.cleanup();
      rmSync(vectorTmp, { recursive: true, force: true });
      rmSync(uploadsRoot, { recursive: true, force: true });
    });

    beforeEach(() => {
      process.env.GOVERNING_DOCS_ENABLED = "1";
    });

    it("read path sees the write: upload over HTTP, then list and search through fresh reads", async () => {
      const res = await upload("adminA", ID.wsA);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const { documentId, revisionId, indexState, chunkCount } = res.body.data;
      expect(indexState).toBe("indexed");
      expect(chunkCount).toBeGreaterThan(0);

      const list = await request(app()).get(base(ID.wsA)).set("x-test-user", "memberA");
      expect(list.status).toBe(200);
      const listed = list.body.data.documents.find((d: { id: string }) => d.id === documentId);
      expect(listed).toMatchObject({
        title: "Access control policy",
        framework: "Internal security policy",
        currentRevisionId: revisionId,
        currentRevision: {
          id: revisionId,
          revisionLabel: "v1",
          isCurrent: true,
          indexState: "indexed",
        },
      });
      // The wire shape never carries the server path or the whole text.
      expect(listed.currentRevision).not.toHaveProperty("storagePath");
      expect(listed.currentRevision).not.toHaveProperty("extractedText");

      const hits = await freshIndex().search(
        ID.wsA,
        "service account password must be rotated every ninety days",
        5,
        actor("memberA"),
      );
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]).toMatchObject({ documentId, revisionId, revisionLabel: "v1" });
      expect(hits[0]!.text).toContain("rotated every ninety days");
      // B's document is never in A's results.
      expect(hits.every((h) => h.documentId !== docB.documentId)).toBe(true);

      await request(app())
        .delete(`${base(ID.wsA)}/${documentId}`)
        .set("x-test-user", "adminA")
        .expect(200);
    });

    it("cross-workspace isolation: a member of A gets 404 on B's list, document, revision; search(B) as A is empty", async () => {
      const a = await upload("adminA", ID.wsA, { fields: fieldsFor("Isolation A", "iso-1") });
      expect(a.status).toBe(201);

      for (const who of ["memberA", "adminA"]) {
        const list = await request(app()).get(base(ID.wsB)).set("x-test-user", who);
        expect(list.status).toBe(404);
        const doc = await request(app())
          .get(`${base(ID.wsB)}/${docB.documentId}`)
          .set("x-test-user", who);
        expect(doc.status).toBe(404);
        const rev = await upload(who, ID.wsB, {
          path: `${base(ID.wsB)}/${docB.documentId}/revisions`,
          fields: { revisionLabel: "evil", effectiveDate: "2026-03-01" },
        });
        expect(rev.status).toBe(404);
        const del = await request(app())
          .delete(`${base(ID.wsB)}/${docB.documentId}`)
          .set("x-test-user", who);
        expect(del.status).toBe(404);
      }
      expect(
        await freshIndex().search(ID.wsB, "vendor contract reviewed by legal", 5, actor("memberA")),
      ).toEqual([]);
      expect(
        await freshIndex().search(ID.wsB, "vendor contract reviewed by legal", 5, actor("adminA")),
      ).toEqual([]);
      // B's own admin does find it: the fixture is really there.
      const own = await freshIndex().search(
        ID.wsB,
        "vendor contract reviewed by legal",
        5,
        actor("adminB"),
      );
      expect(own.map((h) => h.documentId)).toContain(docB.documentId);
      // And A's search never returns B's chunk.
      const inA = await freshIndex().search(ID.wsA, "vendor contract legal", 50, actor("adminA"));
      expect(inA.every((h) => h.documentId !== docB.documentId)).toBe(true);

      await request(app())
        .delete(`${base(ID.wsA)}/${a.body.data.documentId}`)
        .set("x-test-user", "adminA")
        .expect(200);
    });

    it("IDOR: B's document id under A's path is 404 for A's admin on every route, and B's row is untouched", async () => {
      const doc = await request(app())
        .get(`${base(ID.wsA)}/${docB.documentId}`)
        .set("x-test-user", "adminA");
      expect(doc.status).toBe(404);
      const rev = await upload("adminA", ID.wsA, {
        path: `${base(ID.wsA)}/${docB.documentId}/revisions`,
        fields: { revisionLabel: "evil", effectiveDate: "2026-03-01" },
      });
      expect(rev.status).toBe(404);
      const del = await request(app())
        .delete(`${base(ID.wsA)}/${docB.documentId}`)
        .set("x-test-user", "adminA");
      expect(del.status).toBe(404);

      const row = await db.governingDocument.findUnique({
        where: { id: docB.documentId },
        include: { revisions: true },
      });
      expect(row?.deletedAt).toBeNull();
      expect(row?.currentRevisionId).toBe(docB.revisionId);
      expect(row?.revisions.map((r) => r.revisionLabel)).toEqual(["2026"]);
    });

    it("a workspace member gets 403 on upload, new revision and delete; an admin succeeds on each", async () => {
      const denied = await upload("memberA", ID.wsA, { fields: fieldsFor("Member try", "m1") });
      expect(denied.status).toBe(403);
      expect(await db.governingDocument.count({ where: { title: "Member try" } })).toBe(0);

      const created = await upload("adminA", ID.wsA, { fields: fieldsFor("Roles doc", "r1") });
      expect(created.status).toBe(201);
      const { documentId } = created.body.data;

      const revPath = `${base(ID.wsA)}/${documentId}/revisions`;
      const revDenied = await upload("memberA", ID.wsA, {
        path: revPath,
        body: POLICY_V2,
        fields: { revisionLabel: "r2", effectiveDate: "2026-04-01" },
      });
      expect(revDenied.status).toBe(403);
      const revOk = await upload("adminA", ID.wsA, {
        path: revPath,
        body: POLICY_V2,
        fields: { revisionLabel: "r2", effectiveDate: "2026-04-01" },
      });
      expect(revOk.status).toBe(201);

      const delDenied = await request(app())
        .delete(`${base(ID.wsA)}/${documentId}`)
        .set("x-test-user", "memberA");
      expect(delDenied.status).toBe(403);
      const delOk = await request(app())
        .delete(`${base(ID.wsA)}/${documentId}`)
        .set("x-test-user", "adminA");
      expect(delOk.status).toBe(200);

      // Soft delete: the row stays, readers stop seeing it.
      const row = await db.governingDocument.findUnique({ where: { id: documentId } });
      expect(row?.deletedAt).not.toBeNull();
      const get = await request(app())
        .get(`${base(ID.wsA)}/${documentId}`)
        .set("x-test-user", "adminA");
      expect(get.status).toBe(404);
      const list = await request(app()).get(base(ID.wsA)).set("x-test-user", "adminA");
      expect(list.body.data.documents.map((d: { id: string }) => d.id)).not.toContain(documentId);
      const afterDelete = await freshIndex().search(
        ID.wsA,
        "rotated every thirty days",
        50,
        actor("adminA"),
        { includeSuperseded: true },
      );
      expect(afterDelete.filter((h) => h.documentId === documentId)).toEqual([]);
      // A second delete finds nothing.
      await request(app())
        .delete(`${base(ID.wsA)}/${documentId}`)
        .set("x-test-user", "adminA")
        .expect(404);
    });

    it("a new revision becomes current, the previous one stays readable, and search defaults to current chunks", async () => {
      const v1 = await upload("adminA", ID.wsA, { fields: fieldsFor("Revisioned", "v1") });
      expect(v1.status).toBe(201);
      const { documentId, revisionId: v1Id } = v1.body.data;
      const v2 = await upload("adminA", ID.wsA, {
        path: `${base(ID.wsA)}/${documentId}/revisions`,
        body: POLICY_V2,
        fields: { revisionLabel: "v2", effectiveDate: "2026-06-01" },
      });
      expect(v2.status, JSON.stringify(v2.body)).toBe(201);
      const v2Id = v2.body.data.revisionId;
      expect(v2.body.data.documentId).toBe(documentId);

      const doc = await request(app())
        .get(`${base(ID.wsA)}/${documentId}`)
        .set("x-test-user", "memberA");
      expect(doc.status).toBe(200);
      expect(doc.body.data.document.currentRevisionId).toBe(v2Id);
      const revs = doc.body.data.document.revisions as Array<{
        id: string;
        isCurrent: boolean;
        revisionLabel: string;
      }>;
      expect(revs.map((r) => [r.id, r.revisionLabel, r.isCurrent]).sort()).toEqual(
        [
          [v1Id, "v1", false],
          [v2Id, "v2", true],
        ].sort(),
      );
      // v1's row still holds its own text.
      const v1Row = await db.governingDocumentRevision.findUnique({ where: { id: v1Id } });
      expect(v1Row?.extractedText).toContain("every ninety days");

      const query = "service account password must be rotated every days";
      const current = await freshIndex().search(ID.wsA, query, 50, actor("memberA"));
      const ofDoc = current.filter((h) => h.documentId === documentId);
      expect(ofDoc.length).toBeGreaterThan(0);
      expect(ofDoc.every((h) => h.revisionId === v2Id)).toBe(true);
      expect(ofDoc.some((h) => h.text.includes("every thirty days"))).toBe(true);
      expect(ofDoc.some((h) => h.text.includes("every ninety days"))).toBe(false);

      const all = await freshIndex().search(ID.wsA, query, 50, actor("memberA"), {
        includeSuperseded: true,
      });
      const allOfDoc = all.filter((h) => h.documentId === documentId);
      expect(new Set(allOfDoc.map((h) => h.revisionId))).toEqual(new Set([v1Id, v2Id]));
      expect(allOfDoc.find((h) => h.revisionId === v1Id)?.text).toContain("every ninety days");

      // A label is one revision.
      const dup = await upload("adminA", ID.wsA, {
        path: `${base(ID.wsA)}/${documentId}/revisions`,
        body: POLICY_V2,
        fields: { revisionLabel: "v2", effectiveDate: "2026-07-01" },
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("REVISION_LABEL_EXISTS");

      // #1869 review — a duplicate label is refused before the upload is parsed or
      // its blob written: new bytes under a taken label leave no orphan file.
      const blobsBefore = readdirSync(uploadsRoot, { recursive: true }).length;
      const dupNew = await upload("adminA", ID.wsA, {
        path: `${base(ID.wsA)}/${documentId}/revisions`,
        body: Buffer.from(`A different policy body, never stored: ${randomUUID()}\n`),
        fields: { revisionLabel: "v2", effectiveDate: "2026-08-01" },
      });
      expect(dupNew.status).toBe(409);
      expect(dupNew.body.error.code).toBe("REVISION_LABEL_EXISTS");
      expect(readdirSync(uploadsRoot, { recursive: true }).length).toBe(blobsBefore);

      await request(app())
        .delete(`${base(ID.wsA)}/${documentId}`)
        .set("x-test-user", "adminA")
        .expect(200);
    });

    it("a project KnowledgeService search in the workspace returns no governing chunk; the table lives under governing/", async () => {
      const res = await upload("adminA", ID.wsA, { fields: fieldsFor("Knowledge iso", "k1") });
      expect(res.status).toBe(201);
      __resetVectorStoreSingleton();
      const knowledge = new KnowledgeService({
        embedder: embedder as unknown as Embedder,
        vectorStore: getVectorStore(),
        bm25: new BM25Index(),
      });
      for (const mode of ["dense", "hybrid"] as const) {
        const result = await knowledge.search(
          ID.projectA,
          "service account password must be rotated every ninety days",
          { k: 20, mode },
        );
        expect(result.hits).toEqual([]);
      }
      expect(await getVectorStore().count(ID.projectA)).toBe(0);

      // The governing table is `<root>/governing/<workspaceId>`, and no file
      // outside that directory holds a governing chunk.
      const root = process.env.LANCEDB_PATH!;
      const governingTable = path.join(root, GOVERNING_VECTOR_NAMESPACE, ID.wsA, "table.json");
      expect(existsSync(governingTable)).toBe(true);
      expect(readFileSync(governingTable, "utf8")).toContain("rotated every ninety days");
      const outside = filesUnder(root).filter(
        (f) => !f.startsWith(path.join(root, GOVERNING_VECTOR_NAMESPACE) + path.sep),
      );
      for (const file of outside) {
        expect(readFileSync(file, "utf8")).not.toContain("rotated every ninety days");
      }

      await request(app())
        .delete(`${base(ID.wsA)}/${res.body.data.documentId}`)
        .set("x-test-user", "adminA")
        .expect(200);
    });

    it("rejects an 11 MB file and a disallowed type with the project route's errors", async () => {
      const big = Buffer.alloc(11 * 1024 * 1024, 0x61);
      const tooBig = await upload("adminA", ID.wsA, {
        body: big,
        filename: "big.txt",
        fields: fieldsFor("Rejected upload", "x1"),
      });
      const projectVerdict = validateUpload({
        filename: "big.txt",
        mimeType: "text/plain",
        buffer: Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61),
      });
      expect(projectVerdict.ok).toBe(false);
      if (projectVerdict.ok) return;
      expect(tooBig.status).toBe(projectVerdict.status);
      expect(tooBig.body.error).toMatchObject({
        code: projectVerdict.code,
        message: projectVerdict.message,
      });

      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      const badType = await upload("adminA", ID.wsA, {
        body: png,
        filename: "logo.png",
        contentType: "image/png",
        fields: fieldsFor("Rejected upload", "x2"),
      });
      const projectType = validateUpload({
        filename: "logo.png",
        mimeType: "image/png",
        buffer: png,
      });
      expect(projectType.ok).toBe(false);
      if (projectType.ok) return;
      expect(badType.status).toBe(projectType.status);
      expect(badType.body.error.code).toBe(projectType.code);
      expect(await db.governingDocument.count({ where: { title: "Rejected upload" } })).toBe(0);
    });

    it("stores the blob under a content key, never the client's filename", async () => {
      const res = await upload("adminA", ID.wsA, {
        filename: "../../../etc/passwd.md",
        fields: fieldsFor("Traversal", "t1"),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = await db.governingDocumentRevision.findUnique({
        where: { id: res.body.data.revisionId },
      });
      expect(row?.storagePath.startsWith(`${governingStorageKey(ID.wsA)}/`)).toBe(true);
      expect(row?.storagePath).not.toContain("passwd");
      expect(row?.storagePath).not.toContain("..");
      expect(existsSync(path.join(uploadsRoot, row!.storagePath))).toBe(true);
      await request(app())
        .delete(`${base(ID.wsA)}/${res.body.data.documentId}`)
        .set("x-test-user", "adminA")
        .expect(200);
    });

    it("refuses bad fields, a missing file and a file with no text", async () => {
      const noTitle = await upload("adminA", ID.wsA, {
        fields: { revisionLabel: "v1", effectiveDate: "2026-01-01" },
      });
      expect(noTitle.status).toBe(400);
      expect(noTitle.body.error.code).toBe("VALIDATION_ERROR");
      const badDate = await upload("adminA", ID.wsA, {
        fields: { title: "T", revisionLabel: "v1", effectiveDate: "next tuesday" },
      });
      expect(badDate.status).toBe(400);
      const longLabel = await upload("adminA", ID.wsA, {
        fields: { title: "T", revisionLabel: "x".repeat(65), effectiveDate: "2026-01-01" },
      });
      expect(longLabel.status).toBe(400);

      const noFile = await request(app())
        .post(base(ID.wsA))
        .set("x-test-user", "adminA")
        .field("title", "T")
        .field("revisionLabel", "v1")
        .field("effectiveDate", "2026-01-01");
      expect(noFile.status).toBe(400);
      expect(noFile.body.error.code).toBe("FILE_REQUIRED");

      const blank = await upload("adminA", ID.wsA, {
        body: "   \n\n  ",
        filename: "blank.txt",
        fields: fieldsFor("T", "b1"),
      });
      expect(blank.status).toBe(422);
      expect(blank.body.error.code).toBe("NO_TEXT");

      const twoFiles = await request(app())
        .post(base(ID.wsA))
        .set("x-test-user", "adminA")
        .field("title", "T")
        .attach("file", Buffer.from("a"), "a.txt")
        .attach("file", Buffer.from("b"), "b.txt");
      expect(twoFiles.status).toBe(400);
      expect(twoFiles.body.error.code).toBe("UPLOAD_ERROR");

      expect(await db.governingDocument.count({ where: { title: "T" } })).toBe(0);
    });

    it("a failed embed stores the revision as pending and keeps it out of search", async () => {
      const broken = new GoverningIndex({
        embedder: {
          embed: async () => {
            throw new Error("embedder down");
          },
        },
      });
      const res = await upload("adminA", ID.wsA, {
        a: app(broken),
        fields: fieldsFor("Unindexed", "u1"),
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ indexState: "pending", chunkCount: 0 });
      const row = await db.governingDocumentRevision.findUnique({
        where: { id: res.body.data.revisionId },
      });
      expect(row?.indexState).toBe("pending");
      await request(app())
        .delete(`${base(ID.wsA)}/${res.body.data.documentId}`)
        .set("x-test-user", "adminA")
        .expect(200);
    });

    it("#1918 — a failed embed of a new revision keeps the document in default search by its previous revision, until the sweep recovers it", async () => {
      const v1 = await upload("adminA", ID.wsA, { fields: fieldsFor("Recovering", "v1") });
      expect(v1.status).toBe(201);
      const { documentId, revisionId: v1Id } = v1.body.data;
      const broken = new GoverningIndex({
        embedder: {
          embed: async () => {
            throw new Error("embedder down");
          },
        },
      });
      const v2 = await upload("adminA", ID.wsA, {
        a: app(broken),
        path: `${base(ID.wsA)}/${documentId}/revisions`,
        body: POLICY_V2,
        fields: { revisionLabel: "v2", effectiveDate: "2026-06-01" },
      });
      expect(v2.status).toBe(201);
      expect(v2.body.data.indexState).toBe("pending");
      const v2Id = v2.body.data.revisionId;

      // The list says the current revision is v2 and not yet embedded.
      const list = await request(app()).get(base(ID.wsA)).set("x-test-user", "memberA");
      expect(
        list.body.data.documents.find((d: { id: string }) => d.id === documentId),
      ).toMatchObject({ currentRevision: { id: v2Id, indexState: "pending", isCurrent: true } });

      // Default search still finds the document, answered (and labelled) by v1.
      const query = "service account password must be rotated every days";
      const during = (await freshIndex().search(ID.wsA, query, 50, actor("memberA"))).filter(
        (h) => h.documentId === documentId,
      );
      expect(during.length).toBeGreaterThan(0);
      expect(during.every((h) => h.revisionId === v1Id && h.revisionLabel === "v1")).toBe(true);
      expect(during.some((h) => h.text.includes("every ninety days"))).toBe(true);

      // The sweep embeds the pending revision from its stored text, and search moves to v2.
      const swept = await reindexGoverningRevisions({ index: freshIndex() });
      expect(swept.failures).toEqual([]);
      expect(swept.rebuiltWorkspaces).toEqual([]);
      expect(swept.reindexed.map((r) => r.revisionId)).toEqual([v2Id]);
      const row = await db.governingDocumentRevision.findUnique({ where: { id: v2Id } });
      expect(row?.indexState).toBe("indexed");
      const after = (await freshIndex().search(ID.wsA, query, 50, actor("memberA"))).filter(
        (h) => h.documentId === documentId,
      );
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((h) => h.revisionId === v2Id)).toBe(true);
      expect(after.some((h) => h.text.includes("every thirty days"))).toBe(true);

      await request(app())
        .delete(`${base(ID.wsA)}/${documentId}`)
        .set("x-test-user", "adminA")
        .expect(200);
    });

    it("#1918 — after an embedding-model change search finds nothing until the sweep rebuilds every workspace's table", async () => {
      const res = await upload("adminA", ID.wsA, { fields: fieldsFor("Model change", "m1") });
      expect(res.status).toBe(201);
      const { documentId, revisionId } = res.body.data;
      const query = "service account password must be rotated every ninety days";
      const renamed = bowEmbedder("test-bow-v2", 48);

      // On the new model the old rows are filtered out: the document is dark.
      expect(
        (await freshIndex(renamed).search(ID.wsA, query, 50, actor("memberA"))).filter(
          (h) => h.documentId === documentId,
        ),
      ).toEqual([]);

      try {
        const swept = await reindexGoverningRevisions({ index: freshIndex(renamed) });
        expect(swept.skipped).toBe(false);
        expect(swept.failures).toEqual([]);
        expect(new Set(swept.rebuiltWorkspaces)).toEqual(new Set([ID.wsA, ID.wsB]));
        expect(swept.reindexed.map((r) => r.revisionId)).toEqual(
          expect.arrayContaining([revisionId, docB.revisionId]),
        );

        const hits = await freshIndex(renamed).search(ID.wsA, query, 50, actor("memberA"));
        expect(hits.find((h) => h.documentId === documentId)?.revisionId).toBe(revisionId);
        const inB = await freshIndex(renamed).search(
          ID.wsB,
          "vendor contract reviewed by legal",
          5,
          actor("adminB"),
        );
        expect(inB.map((h) => h.documentId)).toContain(docB.documentId);
        // Every stored row is on the new model now: nothing of the old one is left.
        const stored = await freshIndex(renamed).storedIdentities(ID.wsA);
        expect(new Set([...stored.values()].flatMap((s) => [...s]))).toEqual(
          new Set(["test-bow-v2"]),
        );
        // A second sweep has nothing to do.
        const again = await reindexGoverningRevisions({ index: freshIndex(renamed) });
        expect(again.reindexed).toEqual([]);
        expect(again.rebuiltWorkspaces).toEqual([]);
      } finally {
        // Back to the suite's model, so the tests after this one read their own rows.
        await reindexGoverningRevisions({ index: freshIndex() });
        await request(app())
          .delete(`${base(ID.wsA)}/${documentId}`)
          .set("x-test-user", "adminA")
          .expect(200);
      }
    });

    it("#1947 — the fallback serves the NEWEST embedded revision: v1 and v2 indexed, v3 pending, hits come from v2", async () => {
      const v1 = await upload("adminA", ID.wsA, { fields: fieldsFor("Newest first", "v1") });
      expect(v1.status).toBe(201);
      const { documentId } = v1.body.data;
      const revisionsPath = `${base(ID.wsA)}/${documentId}/revisions`;
      const v2 = await upload("adminA", ID.wsA, {
        path: revisionsPath,
        body: POLICY_V2,
        fields: { revisionLabel: "v2", effectiveDate: "2026-06-01" },
      });
      expect(v2.body.data.indexState).toBe("indexed");
      const broken = new GoverningIndex({
        embedder: {
          embed: async () => {
            throw new Error("embedder down");
          },
        },
      });
      const v3 = await upload("adminA", ID.wsA, {
        a: app(broken),
        path: revisionsPath,
        body: POLICY_V2.replace("thirty", "seven"),
        fields: { revisionLabel: "v3", effectiveDate: "2026-09-01" },
      });
      expect(v3.body.data.indexState).toBe("pending");

      const hits = (
        await freshIndex().search(
          ID.wsA,
          "service account password must be rotated every days",
          50,
          actor("memberA"),
        )
      ).filter((h) => h.documentId === documentId);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.revisionId === v2.body.data.revisionId)).toBe(true);
      expect(hits.every((h) => h.revisionLabel === "v2")).toBe(true);

      await request(app())
        .delete(`${base(ID.wsA)}/${documentId}`)
        .set("x-test-user", "adminA");
    });

    it("#1947 — a revision uploaded between the sweep's snapshot and its rebuild is searchable afterwards, and search is not empty during the rebuild", async () => {
      const query = "service account password must be rotated every days";
      const v1 = await upload("adminA", ID.wsA, { fields: fieldsFor("Raced", "v1") });
      expect(v1.status).toBe(201);
      const { documentId } = v1.body.data;
      // The model changes; the vector width does not, so a live upload can still
      // write into the old table — the shape of the race.
      const renamed = bowEmbedder("test-bow-race", DIM);
      const sweepIndex = freshIndex(renamed);
      let v3Id = "";
      const duringRebuild: string[] = [];

      // Step 1: the sweep has taken its snapshot (listReindexTargets) and reads
      // the table's identities next. Before it does, an admin uploads v3 on the
      // new model: v3 is stored, embedded into the LIVE table and marked indexed.
      const realStored = sweepIndex.storedIdentities.bind(sweepIndex);
      vi.spyOn(sweepIndex, "storedIdentities").mockImplementationOnce(async (ws) => {
        const v3 = await upload("adminA", ID.wsA, {
          a: app(new GoverningIndex({ embedder: renamed })),
          path: `${base(ID.wsA)}/${documentId}/revisions`,
          body: POLICY_V2,
          fields: { revisionLabel: "v3", effectiveDate: "2026-09-01" },
        });
        expect(v3.body.data.indexState).toBe("indexed");
        v3Id = v3.body.data.revisionId;
        return realStored(ws);
      });
      // Step 2: while A's rebuild writes, A's search still reads the live table.
      // One search per shadow write of A's: each must find v3.
      const realIndex = sweepIndex.indexRevision.bind(sweepIndex);
      vi.spyOn(sweepIndex, "indexRevision").mockImplementation(async (input, opts) => {
        if (opts?.shadow && input.workspaceId === ID.wsA) {
          const hits = await new GoverningIndex({ embedder: renamed }).search(
            ID.wsA,
            query,
            50,
            actor("memberA"),
          );
          duringRebuild.push(
            hits
              .filter((h) => h.documentId === documentId)
              .map((h) => h.revisionId)
              .join(","),
          );
        }
        return realIndex(input, opts);
      });

      try {
        const swept = await reindexGoverningRevisions({ index: sweepIndex });
        expect(swept.failures).toEqual([]);
        expect(swept.rebuiltWorkspaces).toContain(ID.wsA);
        expect(swept.reindexed.map((r) => r.revisionId)).toContain(v3Id);
        // v3 was in the live table while the rebuild ran...
        expect(duringRebuild.length).toBeGreaterThan(0);
        for (const found of duringRebuild) {
          expect(new Set(found.split(","))).toEqual(new Set([v3Id]));
        }
        // ...and is current, indexed and searchable after it.
        const row = await db.governingDocumentRevision.findUnique({ where: { id: v3Id } });
        expect(row?.indexState).toBe("indexed");
        const after = (
          await freshIndex(renamed).search(ID.wsA, query, 50, actor("memberA"))
        ).filter((h) => h.documentId === documentId);
        expect(after.length).toBeGreaterThan(0);
        expect(after.every((h) => h.revisionId === v3Id)).toBe(true);
      } finally {
        await reindexGoverningRevisions({ index: freshIndex() });
        await request(app())
          .delete(`${base(ID.wsA)}/${documentId}`)
          .set("x-test-user", "adminA");
      }
    });

    it("#1918 — the sweep touches nothing with the flag off", async () => {
      delete process.env.GOVERNING_DOCS_ENABLED;
      const index = freshIndex();
      const probe = vi.spyOn(index, "activeEmbeddingIdentity");
      const swept = await reindexGoverningRevisions({ index });
      expect(swept).toMatchObject({ skipped: true, revisions: 0, reindexed: [] });
      expect(probe).not.toHaveBeenCalled();
    });

    it("a deployment admin reads a live workspace without membership, and nobody reads a soft-deleted one", async () => {
      const list = await request(app()).get(base(ID.wsB)).set("x-test-user", "sysadmin");
      expect(list.status).toBe(200);
      expect(list.body.data.documents.map((d: { id: string }) => d.id)).toContain(docB.documentId);
      const hits = await freshIndex().search(ID.wsB, "vendor contract", 5, actor("sysadmin"));
      expect(hits.map((h) => h.documentId)).toContain(docB.documentId);

      const gone = await upload("adminA", ID.wsGone, { fields: fieldsFor("Gone doc", "g1") });
      expect(gone.status).toBe(201);
      await db.workspace.update({ where: { id: ID.wsGone }, data: { deletedAt: new Date() } });
      for (const who of ["adminA", "sysadmin"]) {
        const res = await request(app()).get(base(ID.wsGone)).set("x-test-user", who);
        expect(res.status).toBe(404);
        const doc = await request(app())
          .get(`${base(ID.wsGone)}/${gone.body.data.documentId}`)
          .set("x-test-user", who);
        expect(doc.status).toBe(404);
      }
      expect(await freshIndex().search(ID.wsGone, "password rotated", 5, actor("adminA"))).toEqual(
        [],
      );
      expect(
        await freshIndex().search(ID.wsGone, "password rotated", 5, actor("sysadmin")),
      ).toEqual([]);
      // A nonexistent workspace is as absent for a deployment admin.
      const missing = await request(app()).get(base("nope1869")).set("x-test-user", "sysadmin");
      expect(missing.status).toBe(404);
    });

    it("with the flag off every route is 404 and search returns nothing", async () => {
      delete process.env.GOVERNING_DOCS_ENABLED;
      const calls = [
        request(app()).get(base(ID.wsB)).set("x-test-user", "adminB"),
        request(app())
          .get(`${base(ID.wsB)}/${docB.documentId}`)
          .set("x-test-user", "adminB"),
        request(app())
          .delete(`${base(ID.wsB)}/${docB.documentId}`)
          .set("x-test-user", "adminB"),
        upload("adminB", ID.wsB, { fields: fieldsFor("Flag off", "f1") }),
        upload("adminB", ID.wsB, {
          path: `${base(ID.wsB)}/${docB.documentId}/revisions`,
          fields: { revisionLabel: "f2", effectiveDate: "2026-01-01" },
        }),
        // Unauthenticated too: off, the routes do not exist.
        request(app()).get(base(ID.wsB)),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
      }
      expect(await freshIndex().search(ID.wsB, "vendor contract", 5, actor("adminB"))).toEqual([]);
      const row = await db.governingDocument.findUnique({
        where: { id: docB.documentId },
        include: { revisions: true },
      });
      expect(row?.deletedAt).toBeNull();
      expect(row?.revisions).toHaveLength(1);
      expect(await db.governingDocument.count({ where: { title: "Flag off" } })).toBe(0);
    });
  },
);

function fieldsFor(title: string, revisionLabel: string): Record<string, string> {
  return { title, revisionLabel, effectiveDate: "2026-01-01T00:00:00Z" };
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}
