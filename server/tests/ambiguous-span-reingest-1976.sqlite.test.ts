/**
 * #1976 — a code citation whose span two repositories hold identically, and
 * which names no repository, is written as a file-level link: no symbol bound,
 * no graph stamped. Before the fix the seeder bound it to the lowest symbol id
 * (one graph's symbol, a guess), and the next ingest of that graph picked the
 * unstamped link up through its symbol and stamped the guess `fresh`, the very
 * result #1975 withheld at write time.
 *
 * Real SQLite built from the migration chain and the REAL ingest
 * (`ingestCodeGraph`, whose hooks capture the cited identity and re-validate):
 * two repositories with the same `src/auth.ts`, so `login` has the same span
 * in both graphs. Both are ingested, the links are written through the real
 * seeder, then BOTH repositories are re-ingested at a new commit (so whichever
 * graph the guess named is re-validated). Read back on a second Prisma client.
 *
 * The same span resolves when the citation names its repository: that link is
 * bound to the named repo's symbol and re-validated at the new commit.
 *
 * #1981 — a link the seeder wrote before #1976 (the same span bound to one
 * graph's `login` by guess) is rewritten in place by the re-seed as the
 * file-level link, rather than left bound beside a new one for the re-ingest
 * to stamp.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.AI_OFFLINE = "1";
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
// The BRD staleness nudge a new link fires is not what this test is about.
vi.mock("../src/lib/docs-gen/approved-requirements-staleness.js", () => ({
  noteRequirementCodeLinksChanged: vi.fn(),
}));
vi.mock("../src/lib/code-graph/sql-lineage-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/code-graph/sql-lineage-client.js")>();
  return { ...actual, isSqlLineageEnabled: () => false };
});
// No embedder: the ingest's embedding hand-off is not what this test is about.
vi.mock("../src/lib/code-graph/symbol-embedding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/code-graph/symbol-embedding-service.js")>()),
  enqueueSymbolEmbeddings: vi.fn(),
  embedProjectSymbols: vi.fn(),
}));

const { ingestCodeGraph } = await import("../src/lib/code-graph/ingest.js");
const { seedRequirementCodeLinksFromFindings } =
  await import("../src/lib/traceability/seed-code-links-from-findings.js");

const USER = "u-1976";
const PROJ = "proj-1976";
const AUTH = "src/auth.ts";
const AUTH_SOURCE = [
  "export function login(user: string, password: string): boolean {",
  "  if (!user) return false;",
  "  const ok = password.length > 8;",
  "  return ok;",
  "}",
  "",
].join("\n");
const SHA = { before: "1".repeat(40), after: "2".repeat(40) };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1976 — an ambiguous cross-repo span binds no symbol, and a re-ingest does not stamp it",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let reader: PrismaClient;
    let scratch: string;
    const repo = { A: "conn-A-1976", B: "conn-B-1976" };
    const req = { ambiguous: "", named: "", guessed: "" };
    let guessedId = "";

    const ingest = async (key: "A" | "B", commitSha: string) => {
      const rootDir = path.join(scratch, `repo-${key}`);
      await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
      await fs.writeFile(path.join(rootDir, AUTH), AUTH_SOURCE);
      await ingestCodeGraph(db, {
        projectId: PROJ,
        rootDir,
        repoConnectionId: repo[key],
        commitSha,
      });
    };

    async function requirementCiting(title: string, citation: object): Promise<string> {
      // A pass with no repository: only the citation itself could name one.
      const pass = await db.agentResult.create({
        data: { analysisId: "an-1976", agentKey: "code" },
      });
      const finding = await db.finding.create({
        data: {
          agentResultId: pass.id,
          category: "rationale",
          title,
          body: title,
          confidence: 0.8,
          evidence: JSON.stringify({ citations: [citation] }),
        },
      });
      return (
        await db.requirement.create({
          data: {
            projectId: PROJ,
            analysisId: "an-1976",
            title,
            body: title,
            labels: JSON.stringify([`finding:${finding.id}`]),
          },
        })
      ).id;
    }

    const linkOf = (requirementId: string) =>
      reader.requirementCodeMapping.findFirstOrThrow({
        where: { projectId: PROJ, requirementId },
      });

    beforeAll(async () => {
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-1976-"));
      sqlite = createMigratedSqlite("1976-ambiguous-span");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      reader = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: "U", email: "u1976@example.test" },
      });
      await db.project.create({ data: { id: PROJ, name: PROJ, slug: PROJ, createdById: USER } });
      await db.analysis.create({ data: { id: "an-1976", projectId: PROJ, startedById: USER } });
      for (const key of ["A", "B"] as const) {
        await db.repoConnection.create({
          data: { id: repo[key], projectId: PROJ, label: `repo-${key}`, createdById: USER },
        });
        await ingest(key, SHA.before);
      }

      const span = { filePath: AUTH, startLine: 2, endLine: 4 };
      req.ambiguous = await requirementCiting("Ambiguous", span);
      req.named = await requirementCiting("Named", { ...span, repoConnectionId: repo.B });
      // #1981 — what the seeder wrote before #1976: graph A's `login`, bound by guess.
      req.guessed = await requirementCiting("Guessed", span);
      const guess = await db.codeSymbol.findFirstOrThrow({
        where: {
          projectId: PROJ,
          filePath: AUTH,
          kind: "function",
          graph: { repoConnectionId: repo.A },
        },
      });
      guessedId = (
        await db.requirementCodeMapping.create({
          data: {
            requirementId: req.guessed,
            projectId: PROJ,
            codeSymbolId: guess.id,
            filePath: AUTH,
            startLine: guess.startLine,
            endLine: guess.endLine,
            confidence: 0.8,
            source: "analysis-grounding",
            symbolQualifiedName: guess.qualifiedName,
            symbolKind: guess.kind,
            symbolContentHash: guess.contentHash,
          },
        })
      ).id;
      await seedRequirementCodeLinksFromFindings({
        analysisId: "an-1976",
        projectId: PROJ,
        requirementIds: [req.ambiguous, req.named, req.guessed],
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      await reader?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    it("both graphs hold `login` with the same span (the precondition)", async () => {
      const spans = await reader.codeSymbol.findMany({
        where: { projectId: PROJ, filePath: AUTH, kind: "function" },
        select: { startLine: true, endLine: true, graph: { select: { repoConnectionId: true } } },
      });
      expect(new Set(spans.map((s) => s.graph.repoConnectionId))).toEqual(
        new Set([repo.A, repo.B]),
      );
      expect(new Set(spans.map((s) => `${s.startLine}-${s.endLine}`)).size).toBe(1);
    });

    it("writes the ambiguous span as an unstamped file-level link", async () => {
      expect(await linkOf(req.ambiguous)).toMatchObject({
        codeSymbolId: null,
        filePath: AUTH,
        startLine: 2,
        endLine: 4,
        symbolQualifiedName: null,
        codeGraphId: null,
        commitSha: null,
        freshness: "unverified",
        validatedAt: null,
      });
    });

    it("rewrites the guessed link in place as the file-level link, adding none beside it (#1981)", async () => {
      const rows = await reader.requirementCodeMapping.findMany({
        where: { projectId: PROJ, requirementId: req.guessed },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: guessedId,
        codeSymbolId: null,
        startLine: 2,
        endLine: 4,
        symbolQualifiedName: null,
        codeGraphId: null,
        freshness: "unverified",
      });
    });

    // #1981 — this phase re-ingests in its own hook, so no test depends on
    // another having run first.
    describe("after both repositories are re-ingested at a new commit", () => {
      beforeAll(async () => {
        await ingest("A", SHA.after);
        await ingest("B", SHA.after);
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      it("the ambiguous link, and the one that was a guess, are still unstamped", async () => {
        for (const requirementId of [req.ambiguous, req.guessed]) {
          expect(await linkOf(requirementId)).toMatchObject({
            codeSymbolId: null,
            codeGraphId: null,
            commitSha: null,
            freshness: "unverified",
            validatedAt: null,
          });
        }
      });

      it("the link whose citation names its repository is bound there and re-validated at the new commit", async () => {
        const graphB = await reader.codeGraph.findFirstOrThrow({
          where: { repoConnectionId: repo.B },
          orderBy: { createdAt: "desc" },
        });
        const row = await linkOf(req.named);
        expect(row).toMatchObject({
          symbolQualifiedName: `${AUTH}::login`,
          codeGraphId: graphB.id,
          commitSha: SHA.after,
          freshness: "fresh",
        });
        const bound = await reader.codeSymbol.findUniqueOrThrow({
          where: { id: row.codeSymbolId! },
        });
        expect(bound.codeGraphId).toBe(graphB.id);
      });
    });
  },
);
