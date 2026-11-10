/**
 * #2142 — two holes #2101's compare-and-set left open, read back through a
 * real SQLite database built by the migration chain and the real router:
 *
 * 1. A submit committed its round, then wrote the refined requirements in a
 *    second transaction. Anything that stopped it between the two (a crash, a
 *    failed write) left the round consumed with no refined requirements, and
 *    the analyst could not answer again. Both now land in one transaction: an
 *    independent connection reading the dialog row while the requirements are
 *    being written still sees the round open, and a failed write leaves it so.
 * 2. A start wrote its new round unconditionally after its model call, over
 *    whatever another writer stored meanwhile. It now writes by compare-and-set
 *    and, when it loses, answers with the stored state.
 */
import Database from "better-sqlite3";
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

const ANSWER = "Only EU invoices";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return {
    db: null as unknown,
    /** Runs inside the next question-generation call, before it answers. */
    duringQuestions: null as null | (() => Promise<void>),
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
vi.mock("../src/lib/finops/token-tracker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/finops/token-tracker.js")>()),
  recordUsage: vi.fn(),
}));
vi.mock("../src/lib/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ai/index.js")>();
  const reply = (content: unknown) => ({
    content: JSON.stringify(content),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    model: "offline-stub",
    provider: "offline-stub",
    offline: true,
  });
  const chat = vi.fn(async (messages: Array<{ content: string }>) => {
    const asked = messages.map((m) => m.content).join("\n");
    if (asked.includes("generate targeted clarifying questions")) {
      const during = state.duringQuestions;
      state.duringQuestions = null;
      await during?.();
      return reply({
        questions: [
          {
            requirementId: "REQ-1",
            ambiguityField: "scope",
            question: "Which invoices does the export cover?",
            context: "",
          },
        ],
      });
    }
    return reply({
      resolvedFields: ["scope"],
      updatedDescription: `Export the monthly invoice report: ${ANSWER}.`,
    });
  });
  return {
    ...actual,
    buildProvider: vi.fn(() => ({ offline: true, chat })),
    loadAIConfig: vi.fn(() => ({ provider: "offline-stub", model: "offline-stub" })),
  };
});
vi.mock("../src/lib/rag/knowledge-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: vi.fn(() => ({ search: vi.fn(async () => []) })),
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WORKSPACE = "ws-2142";
const PROJECT = "proj-2142";
const ADMIN = "u-2142-admin";
const ORIGINAL = "Export the monthly invoice report.";

const R1 = {
  id: "REQ-1",
  title: "Export the monthly invoice report",
  description: ORIGINAL,
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [
    { field: "scope", description: "Which invoices?", suggestedQuestion: "Which invoices?" },
  ],
  evidenceNeeds: [],
  rawSource: "",
};

const OPEN_ROUND = (analysisId: string) =>
  JSON.stringify({
    analysisId,
    currentRound: 1,
    maxRounds: 3,
    rounds: [
      {
        round: 1,
        questions: [
          {
            id: "q-1",
            requirementId: "REQ-1",
            ambiguityField: "scope",
            question: "Which invoices does the export cover?",
            context: "",
            groundingStatus: "open",
          },
        ],
        answers: [],
      },
    ],
    resolvedAmbiguities: [],
    escalatedToSonnet: false,
    completed: false,
  });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2142 — the clarify round and its requirements commit together; a start writes by compare-and-set",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    /** A second connection, outside every Prisma transaction: what another server reads. */
    let other: Database.Database;
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const token = () =>
      issueTokens({
        userId: ADMIN,
        username: ADMIN,
        role: "admin",
        permissions: [],
        workspaces: [WORKSPACE],
      }).accessToken;
    const clarify = (analysisId: string, body: object) =>
      request(app())
        .post(`/api/projects/${PROJECT}/analyses/${analysisId}/clarify`)
        .set("Authorization", `Bearer ${token()}`)
        .send(body);

    /** A run at its checkpoint; with `dialog`, its stored dialog row. */
    async function seedAnalysis(dialog?: (id: string) => string): Promise<string> {
      seq += 1;
      const id = `ana-2142-${seq}`;
      await db.analysis.create({
        data: {
          id,
          projectId: PROJECT,
          startedById: ADMIN,
          status: "completed",
          metadata: JSON.stringify({
            structuredRequirements: {
              requirements: [R1],
              totalAmbiguities: 1,
              totalEvidenceNeeds: 0,
            },
            structuredRunId: "extraction-run-2142",
          }),
        },
      });
      if (dialog) {
        await db.clarificationDialogState.create({ data: { analysisId: id, state: dialog(id) } });
      }
      return id;
    }

    const storedRow = (analysisId: string) =>
      (
        other
          .prepare("SELECT state FROM clarification_dialog_states WHERE analysisId = ?")
          .get(analysisId) as { state: string } | undefined
      )?.state;
    const storedDescription = async (analysisId: string) => {
      const row = await db.analysis.findUniqueOrThrow({ where: { id: analysisId } });
      return (
        JSON.parse(row.metadata ?? "{}").structuredRequirements as {
          requirements: Array<{ description: string }>;
        }
      ).requirements[0]!.description;
    };

    /**
     * The database with a hook on the metadata write a submit makes inside an
     * interactive transaction: `hook` runs before that write, and may throw.
     */
    function withMetadataWriteHook(hook: () => void): PrismaClient {
      const wrapTx = (tx: PrismaClient) =>
        new Proxy(tx, {
          get(target, key) {
            const value = Reflect.get(target, key) as unknown;
            if (key !== "analysis") return value;
            const delegate = value as PrismaClient["analysis"];
            return new Proxy(delegate, {
              get(d, method) {
                const fn = Reflect.get(d, method) as unknown;
                if (method !== "update" || typeof fn !== "function") return fn;
                return (...args: unknown[]) => {
                  hook();
                  return (fn as (...a: unknown[]) => unknown).apply(d, args);
                };
              },
            });
          },
        });
      return new Proxy(db, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if (key === "$transaction") {
            return (fn: (tx: PrismaClient) => Promise<unknown>, opts?: unknown) =>
              target.$transaction((tx) => fn(wrapTx(tx as PrismaClient)), opts as never);
          }
          return typeof value === "function" ? (value as () => unknown).bind(target) : value;
        },
      });
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2142-clarify-transaction");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      other = new Database(sqlite.dbFile, { readonly: true });
      await db.workspace.create({ data: { id: WORKSPACE, name: "ws", slug: WORKSPACE } });
      await db.user.create({
        data: { id: ADMIN, username: ADMIN, displayName: ADMIN, email: `${ADMIN}@example.test` },
      });
      await db.workspaceMember.create({
        data: { workspaceId: WORKSPACE, userId: ADMIN, role: "member" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: ADMIN,
          workspaceId: WORKSPACE,
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      state.db = db;
      state.duringQuestions = null;
    });

    afterAll(async () => {
      other?.close();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("while the refined requirements are written, no other reader sees the round committed", async () => {
      const id = await seedAnalysis(OPEN_ROUND);
      const seeded = storedRow(id);
      const seen: Array<string | undefined> = [];
      state.db = withMetadataWriteHook(() => seen.push(storedRow(id)));

      const res = await clarify(id, { answers: [{ questionId: "q-1", answer: ANSWER }] });

      expect(res.status).toBe(200);
      // The metadata write ran inside the round's transaction: the round was
      // not yet visible outside it, so a crash there would have lost neither.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBe(seeded);
      // And once committed, both are there.
      expect(JSON.parse(storedRow(id)!)).toMatchObject({ currentRound: 2 });
      expect(await storedDescription(id)).toBe(`Export the monthly invoice report: ${ANSWER}.`);
    });

    it("a metadata write that fails leaves the round open, and it can be answered again", async () => {
      const id = await seedAnalysis(OPEN_ROUND);
      const seeded = storedRow(id);
      state.db = withMetadataWriteHook(() => {
        throw new Error("connection lost while writing the requirements");
      });

      const failed = await clarify(id, { answers: [{ questionId: "q-1", answer: ANSWER }] });

      expect(failed.status).toBe(500);
      expect(storedRow(id)).toBe(seeded);
      expect(await storedDescription(id)).toBe(ORIGINAL);

      state.db = db;
      const retried = await clarify(id, { answers: [{ questionId: "q-1", answer: ANSWER }] });
      expect(retried.status).toBe(200);
      expect(JSON.parse(storedRow(id)!)).toMatchObject({ currentRound: 2 });
      expect(await storedDescription(id)).toBe(`Export the monthly invoice report: ${ANSWER}.`);
    });

    it("a first start that loses to another start's write answers with the stored round", async () => {
      const id = await seedAnalysis();
      // Another server's start writes round 1 while this one generates its own.
      const theirs = OPEN_ROUND(id);
      state.duringQuestions = async () => {
        await db.clarificationDialogState.create({ data: { analysisId: id, state: theirs } });
      };

      const res = await clarify(id, {});

      expect(res.status).toBe(200);
      expect(storedRow(id)).toBe(theirs);
      expect(res.body.data).toEqual(JSON.parse(theirs));
    });

    it("a next-round start does not write over a write that landed during its model call", async () => {
      const answered = (analysisId: string) => {
        const s = JSON.parse(OPEN_ROUND(analysisId)) as {
          currentRound: number;
          rounds: Array<{ answers: unknown[] }>;
          answeredAmbiguities?: string[];
        };
        s.currentRound = 2;
        s.rounds[0]!.answers = [{ questionId: "q-1", answer: "Some" }];
        return JSON.stringify(s);
      };
      const id = await seedAnalysis(answered);
      const meanwhile = JSON.stringify({ ...JSON.parse(answered(id)), escalatedToSonnet: true });
      state.duringQuestions = async () => {
        await db.clarificationDialogState.update({
          where: { analysisId: id },
          data: { state: meanwhile },
        });
      };

      const res = await clarify(id, {});

      expect(res.status).toBe(200);
      expect(storedRow(id)).toBe(meanwhile);
      expect(res.body.data).toEqual(JSON.parse(meanwhile));
    });

    it("a start whose dialog was deleted meanwhile writes nothing and asks for a reload", async () => {
      const id = await seedAnalysis();
      // Seed an answered round 1, so the start generates round 2.
      const answered = JSON.parse(OPEN_ROUND(id)) as {
        currentRound: number;
        rounds: Array<{ answers: unknown[] }>;
      };
      answered.currentRound = 2;
      answered.rounds[0]!.answers = [{ questionId: "q-1", answer: "Some" }];
      await db.clarificationDialogState.create({
        data: { analysisId: id, state: JSON.stringify(answered) },
      });
      state.duringQuestions = async () => {
        await db.clarificationDialogState.delete({ where: { analysisId: id } });
      };

      const res = await clarify(id, {});

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CLARIFY_ROUND_NOT_OPEN");
      expect(storedRow(id)).toBeUndefined();
    });

    it("a start that wins its compare-and-set stores the round it answers with", async () => {
      const id = await seedAnalysis();

      const res = await clarify(id, {});

      expect(res.status).toBe(200);
      expect(res.body.data.rounds).toHaveLength(1);
      expect(JSON.parse(storedRow(id)!)).toEqual(res.body.data);
    });
  },
);
