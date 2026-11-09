/**
 * #1870 (epic #1866) — governing rule extraction through the REAL routes, over
 * a REAL SQLite database (the real migration chain). The caller (auth
 * middleware), the audit sink, the embedder and the model are doubles; the
 * model replays the recorded DeepSeek response for the #1867 policy.
 *
 * Every assertion reads back through a fresh HTTP request, never the job's
 * in-memory result, so rules the job reports but did not commit fail here.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const who = String(req.headers["x-test-user"] ?? "");
    const user = (globalThis as unknown as { __users1870: Record<string, unknown> }).__users1870[
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

const vectorTmp = mkdtempSync(path.join(os.tmpdir(), "metis-1870-"));
process.env.LANCEDB_PATH = path.join(vectorTmp, "vectors");

const { governingDocumentsRouter, governingRulesRouter } =
  await import("../src/routes/governing-documents.js");
const { GoverningIndex } = await import("../src/lib/governing/governing-index.js");
const { runRuleExtraction } = await import("../src/lib/governing/rule-extraction.js");
const { EXTRACTION_STALE_MS, beginRuleExtraction, completeRuleExtraction, failRuleExtraction } =
  await import("../src/lib/governing/governing-store.js");
const { sumLedgerUsage, workspaceLedgerWhere } = await import("../src/lib/finops/ledger-totals.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { DocumentStorage } = await import("../src/lib/documents/storage.js");
const { audit } = await import("../src/lib/audit/audit-service.js");
const { AIProviderError } = await import("../src/lib/ai/errors.js");
type AIProvider = import("../src/lib/ai/types.js").AIProvider;

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const POLICY_V1 = readFileSync(
  path.join(ROOT, "eval-data/corpus/governing-01-sample-policy/policy-v1.md"),
  "utf8",
);
const RECORDED = JSON.parse(
  readFileSync(
    path.join(ROOT, "server/src/lib/governing/__fixtures__/policy-v1-extraction.deepseek.json"),
    "utf8",
  ),
) as { replies: string[] };
const RULE_COUNT = 40;

const embedder = {
  embed: async (texts: string[]) => ({
    vectors: texts.map(() => [1, 0, 0]),
    model: "test",
    dimension: 3,
  }),
};

function replay(replies: string[]): AIProvider {
  let i = 0;
  return {
    key: "anthropic",
    model: "deepseek-flash",
    offline: false,
    chat: async () => ({
      content: replies[i++] ?? '{"rules":[]}',
      model: "deepseek-flash",
      provider: "anthropic",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
  } as unknown as AIProvider;
}

const ID = {
  adminA: "u-admin-a70",
  memberA: "u-member-a70",
  adminB: "u-admin-b70",
  wsA: "wsa1870",
  wsB: "wsb1870",
};
const USERS: Record<string, unknown> = {
  adminA: { userId: ID.adminA, username: "admin-a", role: "developer", permissions: [] },
  memberA: { userId: ID.memberA, username: "member-a", role: "developer", permissions: [] },
  adminB: { userId: ID.adminB, username: "admin-b", role: "developer", permissions: [] },
};
(globalThis as unknown as { __users1870: Record<string, unknown> }).__users1870 = USERS;

const docs = (ws: string) => `/api/workspaces/${ws}/governing-documents`;
const rules = (ws: string) => `/api/workspaces/${ws}/governing-rules`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1870 — governing rule extraction (real routes, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let uploadsRoot: string;
    /** The extraction runs the last upload started, so a test can wait for them. */
    let jobs: Array<Promise<void>> = [];

    function app(provider: AIProvider = replay(RECORDED.replies)) {
      const a = express();
      a.use(express.json());
      a.use(
        "/api/workspaces/:workspaceId/governing-documents",
        governingDocumentsRouter({
          storage: new DocumentStorage({ root: uploadsRoot }),
          index: new GoverningIndex({ embedder }),
          extractRules: (input) => {
            const job = runRuleExtraction({ ...input, provider });
            jobs.push(job);
            return job;
          },
        }),
      );
      a.use("/api/workspaces/:workspaceId/governing-rules", governingRulesRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    }

    async function uploadPolicy(
      a: express.Express,
      ws = ID.wsA,
      who = "adminA",
      revisionLabel = "v1",
    ): Promise<{ documentId: string; revisionId: string }> {
      const res = await request(a)
        .post(docs(ws))
        .set("x-test-user", who)
        .field("title", "Harbor Lane Outfitters — Information Handling Policy")
        .field("revisionLabel", revisionLabel)
        .field("effectiveDate", "2026-01-01")
        .attach("file", Buffer.from(POLICY_V1, "utf8"), {
          filename: "policy-v1.md",
          contentType: "text/markdown",
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await Promise.all(jobs);
      jobs = [];
      return res.body.data;
    }

    const getRules = (ws: string, documentId: string, who = "memberA", query = "") =>
      request(app())
        .get(`${docs(ws)}/${documentId}/rules${query}`)
        .set("x-test-user", who);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1870-governing-rules");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      uploadsRoot = mkdtempSync(path.join(os.tmpdir(), "metis-1870-uploads-"));
      for (const [key, id] of Object.entries({
        adminA: ID.adminA,
        memberA: ID.memberA,
        adminB: ID.adminB,
      })) {
        await db.user.create({
          data: { id, username: key, displayName: key, email: `${key}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: ID.wsA, name: "A", slug: "a-1870" } });
      await db.workspace.create({ data: { id: ID.wsB, name: "B", slug: "b-1870" } });
      await db.workspaceMember.createMany({
        data: [
          { workspaceId: ID.wsA, userId: ID.adminA, role: "admin" },
          { workspaceId: ID.wsA, userId: ID.memberA, role: "member" },
          { workspaceId: ID.wsB, userId: ID.adminB, role: "owner" },
        ],
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      process.env.GOVERNING_DOCS_ENABLED = "1";
      jobs = [];
      vi.mocked(audit).mockClear();
    });

    afterAll(async () => {
      delete process.env.GOVERNING_DOCS_ENABLED;
      await db?.$disconnect();
      sqlite?.cleanup();
      rmSync(vectorTmp, { recursive: true, force: true });
      rmSync(uploadsRoot, { recursive: true, force: true });
    });

    it("runs once per revision: a second run on a done revision neither calls the model nor touches rules", async () => {
      const { documentId, revisionId } = await uploadPolicy(app());
      const before = await getRules(ID.wsA, documentId);
      const ac01 = before.body.data.rules.find(
        (r: { controlId: string }) => r.controlId === "AC-01",
      );
      await request(app())
        .patch(`${rules(ID.wsA)}/${ac01.id}`)
        .set("x-test-user", "adminA")
        .send({ summary: "Edited by an admin." });

      const provider = replay(RECORDED.replies);
      const chat = vi.spyOn(provider, "chat");
      await runRuleExtraction({ workspaceId: ID.wsA, revisionId, provider });

      expect(chat).not.toHaveBeenCalled();
      const after = await getRules(ID.wsA, documentId);
      expect(after.body.data.rules).toHaveLength(RULE_COUNT);
      expect(after.body.data.rules.find((r: { id: string }) => r.id === ac01.id).summary).toBe(
        "Edited by an admin.",
      );
    });

    it("round trip: a fresh GET returns the committed rules; a PATCH is read back with its editor", async () => {
      const { documentId, revisionId } = await uploadPolicy(app());

      const listed = await getRules(ID.wsA, documentId);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      const body = listed.body.data;
      expect(body.revision).toMatchObject({
        id: revisionId,
        revisionLabel: "v1",
        extractionState: "done",
        extractionError: null,
        droppedUnverified: 0,
        isCurrent: true,
      });
      expect(body.rules).toHaveLength(RULE_COUNT);
      const row = await db.governingDocumentRevision.findUnique({ where: { id: revisionId } });
      for (const rule of body.rules as Array<{
        clauseStart: number;
        clauseEnd: number;
        clauseExcerpt: string;
      }>) {
        expect(rule.clauseExcerpt).toBe(row!.extractedText.slice(rule.clauseStart, rule.clauseEnd));
      }
      const ac01 = body.rules.find((r: { controlId: string }) => r.controlId === "AC-01");
      expect(ac01).toBeDefined();

      // The document read carries the extraction state too.
      const doc = await request(app())
        .get(`${docs(ID.wsA)}/${documentId}`)
        .set("x-test-user", "memberA");
      expect(doc.body.data.document.revisions[0]).toMatchObject({
        extractionState: "done",
        droppedUnverified: 0,
      });

      const edited = await request(app())
        .patch(`${rules(ID.wsA)}/${ac01.id}`)
        .set("x-test-user", "adminA")
        .send({ summary: "One named person per account; accounts are never shared." });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body.data.changed).toBe(true);

      const after = await getRules(ID.wsA, documentId);
      const reread = after.body.data.rules.find((r: { id: string }) => r.id === ac01.id);
      expect(reread).toMatchObject({
        summary: "One named person per account; accounts are never shared.",
        controlId: "AC-01",
        editedById: ID.adminA,
      });
      expect(reread.editedAt).not.toBeNull();
      const edits = await db.governingRuleEdit.findMany({ where: { ruleId: ac01.id } });
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({ kind: "edit", editedById: ID.adminA });
      expect(JSON.parse(edits[0]!.before)).toEqual({ summary: ac01.summary });
      expect(JSON.parse(edits[0]!.after)).toEqual({
        summary: "One named person per account; accounts are never shared.",
      });
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({ action: "governing_rule.edit", actor: { id: ID.adminA } }),
      );

      // The same values again change nothing and write no history.
      const same = await request(app())
        .patch(`${rules(ID.wsA)}/${ac01.id}`)
        .set("x-test-user", "adminA")
        .send({ summary: "One named person per account; accounts are never shared." });
      expect(same.body.data.changed).toBe(false);
      expect(await db.governingRuleEdit.count({ where: { ruleId: ac01.id } })).toBe(1);

      // A soft delete leaves the row and its history, and the list stops showing it.
      const removed = await request(app())
        .patch(`${rules(ID.wsA)}/${ac01.id}`)
        .set("x-test-user", "adminA")
        .send({ deleted: true });
      expect(removed.status).toBe(200);
      const afterDelete = await getRules(ID.wsA, documentId);
      expect(afterDelete.body.data.rules).toHaveLength(RULE_COUNT - 1);
      expect(afterDelete.body.data.rules.map((r: { id: string }) => r.id)).not.toContain(ac01.id);
      const kept = await db.governingRule.findUnique({ where: { id: ac01.id } });
      expect(kept?.deletedAt).not.toBeNull();
      expect(
        (await db.governingRuleEdit.findMany({ where: { ruleId: ac01.id } })).map((e) => e.kind),
      ).toEqual(["edit", "delete"]);
      // A deleted rule cannot be edited again.
      const again = await request(app())
        .patch(`${rules(ID.wsA)}/${ac01.id}`)
        .set("x-test-user", "adminA")
        .send({ summary: "x" });
      expect(again.status).toBe(404);
    });

    it("a provider failure leaves extractionState=failed with the error on the GET, and the upload stored", async () => {
      const broken = {
        key: "anthropic",
        model: "m",
        offline: false,
        // The shape the Anthropic provider's error mapper throws.
        chat: async () => {
          throw new AIProviderError(
            "anthropic chat failed (APIError): 503 upstream overloaded at gw-internal-7",
            503,
            { provider: "anthropic", operation: "chat", errorName: "APIError" },
          );
        },
      } as unknown as AIProvider;
      const { documentId, revisionId } = await uploadPolicy(app(broken));

      const listed = await getRules(ID.wsA, documentId);
      expect(listed.status).toBe(200);
      expect(listed.body.data.revision).toMatchObject({
        id: revisionId,
        extractionState: "failed",
        extractionError:
          "The AI provider call failed: anthropic chat (APIError, HTTP 503). The provider's own message is in the server log.",
      });
      // Every member reads this: the upstream's own text stays in the server log.
      expect(listed.body.data.revision.extractionError).not.toContain("gw-internal-7");
      expect(listed.body.data.rules).toEqual([]);
      const row = await db.governingDocumentRevision.findUnique({ where: { id: revisionId } });
      expect(row?.extractedText).toBe(POLICY_V1);
      expect(row?.indexState).toBe("indexed");
      const doc = await request(app())
        .get(`${docs(ID.wsA)}/${documentId}`)
        .set("x-test-user", "memberA");
      expect(doc.status).toBe(200);
      expect(doc.body.data.document.currentRevisionId).toBe(revisionId);
    });

    it("a new revision gets its own rules and the previous revision's rules stay readable", async () => {
      const a = app();
      const { documentId, revisionId: v1 } = await uploadPolicy(a, ID.wsA, "adminA", "p1");
      const res = await request(app())
        .post(`${docs(ID.wsA)}/${documentId}/revisions`)
        .set("x-test-user", "adminA")
        .field("revisionLabel", "p2")
        .field("effectiveDate", "2026-07-01")
        .attach("file", Buffer.from(POLICY_V1, "utf8"), {
          filename: "policy-v2.md",
          contentType: "text/markdown",
        });
      expect(res.status).toBe(201);
      await Promise.all(jobs);
      const v2 = res.body.data.revisionId;

      const current = await getRules(ID.wsA, documentId);
      expect(current.body.data.revision).toMatchObject({ id: v2, isCurrent: true });
      expect(current.body.data.rules).toHaveLength(RULE_COUNT);
      const previous = await getRules(ID.wsA, documentId, "memberA", `?revisionId=${v1}`);
      expect(previous.body.data.revision).toMatchObject({ id: v1, isCurrent: false });
      expect(previous.body.data.rules).toHaveLength(RULE_COUNT);
      expect(
        previous.body.data.rules.every((r: { revisionId: string }) => r.revisionId === v1),
      ).toBe(true);
      // A revision id of another document is not this document's.
      const other = await uploadPolicy(app(), ID.wsA, "adminA", "o1");
      const wrong = await getRules(
        ID.wsA,
        documentId,
        "memberA",
        `?revisionId=${other.revisionId}`,
      );
      expect(wrong.status).toBe(404);
    });

    it("access: a member reads but cannot edit; another workspace's admin gets 404 on read and edit", async () => {
      const { documentId } = await uploadPolicy(app());
      const listed = await getRules(ID.wsA, documentId);
      const ruleId = listed.body.data.rules[0].id as string;
      const before = await db.governingRule.findUnique({ where: { id: ruleId } });

      const member = await request(app())
        .patch(`${rules(ID.wsA)}/${ruleId}`)
        .set("x-test-user", "memberA")
        .send({ summary: "member edit" });
      expect(member.status).toBe(403);

      // B's admin, on A's path (not a member) and on B's own path (IDOR).
      expect((await getRules(ID.wsA, documentId, "adminB")).status).toBe(404);
      expect((await getRules(ID.wsB, documentId, "adminB")).status).toBe(404);
      for (const ws of [ID.wsA, ID.wsB]) {
        const res = await request(app())
          .patch(`${rules(ws)}/${ruleId}`)
          .set("x-test-user", "adminB")
          .send({ summary: "cross-workspace edit" });
        expect(res.status).toBe(404);
      }
      expect(await db.governingRule.findUnique({ where: { id: ruleId } })).toEqual(before);
      expect(await db.governingRuleEdit.count({ where: { ruleId } })).toBe(0);
    });

    it("refuses a malformed patch and an unknown rule; with the flag off the rule routes are 404", async () => {
      const { documentId } = await uploadPolicy(app());
      const ruleId = (await getRules(ID.wsA, documentId)).body.data.rules[0].id as string;
      for (const body of [
        {},
        { summary: "" },
        { deleted: false },
        { deleted: true, summary: "both" },
        { clauseExcerpt: "rewritten citation" },
      ]) {
        const res = await request(app())
          .patch(`${rules(ID.wsA)}/${ruleId}`)
          .set("x-test-user", "adminA")
          .send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      const unknown = await request(app())
        .patch(`${rules(ID.wsA)}/nope`)
        .set("x-test-user", "adminA")
        .send({ summary: "x" });
      expect(unknown.status).toBe(404);
      expect((await getRules(ID.wsA, "nope")).status).toBe(404);

      process.env.GOVERNING_DOCS_ENABLED = "0";
      const off = await request(app())
        .patch(`${rules(ID.wsA)}/${ruleId}`)
        .set("x-test-user", "adminA")
        .send({ summary: "x" });
      expect(off.status).toBe(404);
      expect((await getRules(ID.wsA, documentId)).status).toBe(404);
    });

    const retry = (ws: string, documentId: string, revisionId: string, who = "adminA", a = app()) =>
      request(a)
        .post(`${docs(ws)}/${documentId}/revisions/${revisionId}/rule-extraction`)
        .set("x-test-user", who);

    it("#1947 — an admin retries a failed extraction; a done or fresh-running one is 409, a member 403, another workspace 404", async () => {
      const down = {
        key: "anthropic",
        model: "m",
        offline: false,
        chat: async () => {
          throw new Error("provider down");
        },
      } as unknown as AIProvider;
      const { documentId, revisionId } = await uploadPolicy(app(down));
      expect((await getRules(ID.wsA, documentId)).body.data.revision.extractionState).toBe(
        "failed",
      );

      expect((await retry(ID.wsA, documentId, revisionId, "memberA")).status).toBe(403);
      expect((await retry(ID.wsB, documentId, revisionId, "adminB")).status).toBe(404);
      expect((await retry(ID.wsA, documentId, "no-such-revision")).status).toBe(404);

      const res = await retry(ID.wsA, documentId, revisionId);
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body.data).toEqual({ documentId, revisionId, scheduled: true });
      await Promise.all(jobs);
      jobs = [];
      const after = await getRules(ID.wsA, documentId);
      expect(after.body.data.revision).toMatchObject({
        extractionState: "done",
        extractionError: null,
      });
      expect(after.body.data.rules).toHaveLength(RULE_COUNT);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "governing_document.extraction_retry",
          metadata: { workspaceId: ID.wsA, revisionId, previousState: "failed" },
        }),
      );

      const done = await retry(ID.wsA, documentId, revisionId);
      expect(done.status).toBe(409);
      expect(done.body.error.code).toBe("EXTRACTION_NOT_RETRYABLE");

      await db.governingDocumentRevision.update({
        where: { id: revisionId },
        data: { extractionState: "running", extractionStartedAt: new Date() },
      });
      expect((await retry(ID.wsA, documentId, revisionId)).status).toBe(409);
      expect(jobs).toEqual([]);
    });

    it("#1947 — a revision left running by a dead run is retried after the stale bound, and the dead run cannot store its rules", async () => {
      const { documentId, revisionId } = await uploadPolicy(app(replay([])));
      // The state a server restart mid-run leaves: running, rules never stored.
      await db.governingRule.deleteMany({ where: { revisionId } });
      const deadStart = new Date(Date.now() - EXTRACTION_STALE_MS - 60_000);
      await db.governingDocumentRevision.update({
        where: { id: revisionId },
        data: { extractionState: "running", extractionStartedAt: deadStart },
      });
      // #1996 — the list carries the start time, so the page can offer the retry.
      const listed = await request(app()).get(docs(ID.wsA)).set("x-test-user", "memberA");
      expect(
        listed.body.data.documents.find((d: { id: string }) => d.id === documentId)
          ?.currentRevision,
      ).toMatchObject({ extractionState: "running", extractionStartedAt: deadStart.toISOString() });

      const res = await retry(ID.wsA, documentId, revisionId);
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      await Promise.all(jobs);
      jobs = [];
      const row = await db.governingDocumentRevision.findUnique({ where: { id: revisionId } });
      expect(row?.extractionState).toBe("done");
      expect(row?.extractionStartedAt?.getTime()).toBeGreaterThan(deadStart.getTime());
      expect(await db.governingRule.count({ where: { revisionId } })).toBe(RULE_COUNT);

      // The dead run wakes up and tries to commit: it is fenced out.
      const late = await completeRuleExtraction(
        ID.wsA,
        revisionId,
        deadStart,
        [
          {
            controlId: "LATE-1",
            summary: "late",
            clauseRef: "§1",
            clauseStart: 0,
            clauseEnd: 1,
            clauseExcerpt: "#",
          },
        ],
        0,
      );
      expect(late).toBe(false);
      await failRuleExtraction(ID.wsA, revisionId, deadStart, "late failure");
      expect(await db.governingRule.count({ where: { revisionId } })).toBe(RULE_COUNT);
      expect(
        await db.governingDocumentRevision.findUnique({ where: { id: revisionId } }),
      ).toMatchObject({ extractionState: "done", extractionError: null });
    });

    it("#1947 — beginRuleExtraction takes a stale or start-time-less running row, never a fresh one; the replaced run is fenced out", async () => {
      const { revisionId } = await uploadPolicy(app(replay([])));
      const set = (extractionStartedAt: Date | null) =>
        db.governingDocumentRevision.update({
          where: { id: revisionId },
          data: { extractionState: "running", extractionStartedAt },
        });
      await set(new Date());
      expect(await beginRuleExtraction(ID.wsA, revisionId)).toBeNull();
      const deadStart = new Date(Date.now() - EXTRACTION_STALE_MS - 60_000);
      await set(deadStart);
      const begun = await beginRuleExtraction(ID.wsA, revisionId);
      expect(begun?.startedAt).toBeInstanceOf(Date);
      // While the new run is still running, the dead one wakes: both its writes
      // are fenced out, and the row stays the new run's.
      const rule = {
        controlId: "AC-01",
        summary: "s",
        clauseRef: "§1",
        clauseStart: 0,
        clauseEnd: 1,
        clauseExcerpt: "#",
      };
      expect(await completeRuleExtraction(ID.wsA, revisionId, deadStart, [rule], 0)).toBe(false);
      await failRuleExtraction(ID.wsA, revisionId, deadStart, "dead run");
      expect(await db.governingRule.count({ where: { revisionId } })).toBe(0);
      expect(
        await db.governingDocumentRevision.findUnique({ where: { id: revisionId } }),
      ).toMatchObject({ extractionState: "running", extractionError: null });
      expect(await completeRuleExtraction(ID.wsA, revisionId, begun!.startedAt, [rule], 0)).toBe(
        true,
      );
      expect(await db.governingRule.count({ where: { revisionId } })).toBe(1);
      await set(null);
      expect(await beginRuleExtraction(ID.wsA, revisionId)).not.toBeNull();
      // Another workspace's id never reaches the row.
      await set(null);
      expect(await beginRuleExtraction(ID.wsB, revisionId)).toBeNull();
    });

    it("#1947 — every extraction call is a token_usages row under the workspace, counted in its spend", async () => {
      const before = await sumLedgerUsage(workspaceLedgerWhere(ID.wsA));
      const { revisionId } = await uploadPolicy(app());
      const rows = await db.tokenUsage.findMany({ where: { sessionId: revisionId } });
      expect(rows).toHaveLength(RECORDED.replies.length);
      for (const row of rows) {
        expect(row).toMatchObject({
          projectId: null,
          workspaceId: ID.wsA,
          agentStep: "governing.rule-extraction",
          provider: "anthropic",
          model: "deepseek-flash",
          inputTokens: 1,
          outputTokens: 1,
        });
      }
      // The workspace's usage reads them (Settings → Usage, the daily rollup)...
      const after = await sumLedgerUsage(workspaceLedgerWhere(ID.wsA));
      expect(after.calls - before.calls).toBe(RECORDED.replies.length);
      // ...and another workspace's does not.
      const inB = await db.tokenUsage.count({
        where: { AND: [workspaceLedgerWhere(ID.wsB), { sessionId: revisionId }] },
      });
      expect(inB).toBe(0);
    });
  },
);
