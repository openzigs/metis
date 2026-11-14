/**
 * #2448 (epic #2438) — an analysis a person starts reads code with their
 * access, records what each pass read, and every reader sees what they may.
 * End to end over a REAL SQLite database built by the migration chain, the
 * REAL orchestrator code paths over a real clone and fused seed, the real
 * `persistAgentResult`, and the real snapshot read with the #2447 filter.
 *
 * Fixture: one repository with two files, `src/fee.ts` (open) and
 * `src/vault.ts`, whose document Alice alone may read. The fused symbol seed
 * finds a symbol in each. The model answers one finding citing ONLY
 * `src/fee.ts`: a finding written after reading a restricted file, citing an
 * open one, is the case citations alone would let through (#2448 thread).
 *   - Alice's run reads `src/vault.ts`, records it on the pass, and on its
 *     finding: Bob sees the placeholder, Alice and an admin see the finding.
 *   - Bob's run never reads it, and Bob sees his finding.
 *   - A scheduled run reads as the shared audience, as before.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { RESTRICTED_SOURCE_TITLE, type SynthesisOutput } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { FusedCodeSearcher, SymbolLineLookup } from "../src/lib/rag/fused-code-context.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
  resolveDatabaseProvider: () => "sqlite",
}));
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
// The content version must not probe an embedding sidecar.
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));

const {
  createAnalysis,
  getAnalysisSnapshot,
  persistAgentResult,
  persistAnalysisCapability,
  persistRequirements,
} = await import("../src/lib/analysis/analysis-service.js");
const { userSourceReader } = await import("../src/lib/analysis/source-redaction.js");
const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");

const P = "p-2448";
const REPO = "rc-2448";
const GRAPH = "g-2448";
const SECRET_MARK = "VAULT_KEY_2448";
const FINDING_TITLE = "Fee is computed in one place";

type Who = "alice" | "bob" | "root";
const ROLES: Record<Who, string> = { alice: "coordinator", bob: "coordinator", root: "admin" };

interface Stored {
  documentIds: string[];
  chunkIds: string[];
  citations?: Array<{ documentIds: string[]; chunkIds: string[] }>;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2448 — analyses run with the starter's access, and readers see what they may (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let cloneRoot: string;
    const savedCloneDir = process.env.REPO_CLONE_DIR;

    const ANSWER = JSON.stringify({
      agentKey: "code",
      summary: "Read the fee code.",
      notes: [],
      findings: [
        {
          category: "architecture",
          severity: "info",
          title: FINDING_TITLE,
          body: "computeFee returns the fee.",
          requirementId: "REQ-1",
          // Cites the OPEN file only, whatever else the pass read.
          citations: [{ filePath: "src/fee.ts", startLine: 1, endLine: 3 }],
        },
      ],
    });
    const searcher: FusedCodeSearcher = {
      search: async () => [
        {
          symbolId: "s-fee",
          filePath: "src/fee.ts",
          name: "computeFee",
          kind: "function",
          score: 0.9,
        },
        {
          symbolId: "s-vault",
          filePath: "src/vault.ts",
          name: "vaultKey",
          kind: "function",
          score: 0.8,
        },
      ],
    };
    const FILES: Record<string, string> = { "s-fee": "src/fee.ts", "s-vault": "src/vault.ts" };
    const lineLookup: SymbolLineLookup = {
      resolve: async (ids) =>
        new Map(ids.map((id) => [id, { filePath: FILES[id]!, startLine: 1, endLine: 3 }])),
    };

    type Orch = Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
    /** The orchestrator, and every prompt its model was sent. */
    const orchestrator = () => {
      const prompts: string[] = [];
      const orch = new AnalysisOrchestrator({
        provider: {
          key: "offline-stub",
          model: "stub",
          offline: true,
          chat: vi.fn(async (messages: unknown) => {
            prompts.push(JSON.stringify(messages));
            return {
              content: ANSWER,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: "stub",
              provider: "offline-stub",
            };
          }),
        } as never,
        knowledge: { search: async () => ({ hits: [] }) } as never,
        fusedCode: { searcher, lineLookup },
        prepareRepoClone: async () => "healthy",
      }) as unknown as Orch;
      orch.runSynthesisAndPersist = vi.fn(async () => undefined);
      return { orch, prompts: () => prompts.join("\n") };
    };
    const common = (analysisId: string, actorId: string) => ({
      analysisId,
      projectId: P,
      projectName: "Fees",
      projectDescription: "fees",
      signal: new AbortController().signal,
      actorId,
    });
    const REQUIREMENTS = [{ id: "REQ-1", text: "Compute the fee." }];
    const paths: Record<string, (orch: Orch, id: string, actorId: string) => Promise<unknown>> = {
      agentic: (orch, id, actorId) =>
        orch.runAgenticCodeAgent!({
          ...common(id, actorId),
          requirements: REQUIREMENTS,
          connectorId: REPO,
        }),
      "requirement-grounded": (orch, id, actorId) =>
        orch.runRequirementGroundedCodeAgent!({
          ...common(id, actorId),
          requirements: REQUIREMENTS,
          documentIds: ["d-brief"],
        }),
      "single-shot": (orch, id, actorId) =>
        orch.runOneAgent!({ ...common(id, actorId), agentKey: "code", documentIds: ["d-brief"] }),
    };

    /** A run, as `createAnalysis` writes it for `startedById`. */
    const startRun = async (startedById: string) => {
      const run = await createAnalysis({
        projectId: P,
        startedById,
        agentKeys: ["code"],
        documentIds: ["d-brief"],
        title: "Fees",
      });
      await db.analysis.update({
        where: { id: run.id },
        data: {
          // Driven pass by pass below; finished, so it may be regenerated.
          status: "completed",
          metadata: JSON.stringify({
            agentKeys: ["code"],
            documentIds: ["d-brief"],
            extraInstructions: "REQ-1: Compute the fee.",
          }),
        },
      });
      // A capability record, so the snapshot can say what the run read.
      await persistAnalysisCapability(run.id, {
        codeAnalysisRequested: true,
        databaseAnalysisRequested: false,
        codeGraphPresent: true,
        agentMode: "agentic",
        repoSourceIngested: true,
        fusedCodeRetrievalEnabled: true,
        schemaContextEnabled: true,
        quarantineFallbackUsed: false,
        skippedRepos: [],
        reasons: [],
      } as never);
      return run.id;
    };
    const finding = async (analysisId: string) => {
      const row = await db.finding.findFirstOrThrow({
        where: { agentResult: { analysisId } },
        select: { sourceIds: true, agentResult: { select: { readSourceIds: true } } },
      });
      return {
        sources: JSON.parse(row.sourceIds!) as Stored,
        read: row.agentResult?.readSourceIds ?? null,
      };
    };
    const snapshotAs = async (who: Who, analysisId: string) =>
      (await getAnalysisSnapshot(analysisId, { reader: userSourceReader(who) }))!;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("starter-access-2448");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const key of ["coordinator", "admin"]) {
        await db.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      for (const who of Object.keys(ROLES) as Who[]) {
        await db.user.create({
          data: { id: who, username: who, displayName: who, email: `${who}@example.test` },
        });
        await db.userRole.create({ data: { userId: who, roleId: `role-${ROLES[who]}` } });
      }
      await db.project.create({ data: { id: P, name: P, slug: P, createdById: "alice" } });
      await db.repoConnection.create({
        data: { id: REPO, projectId: P, label: REPO, isPrimary: true },
      });
      await db.codeGraph.create({
        data: {
          id: GRAPH,
          projectId: P,
          repoConnectionId: REPO,
          commitSha: "a".repeat(40),
          lastIndexedAt: new Date(),
        },
      });
      for (const [id, name, filePath] of [
        ["s-fee", "computeFee", "src/fee.ts"],
        ["s-vault", "vaultKey", "src/vault.ts"],
      ] as const) {
        await db.codeSymbol.create({
          data: {
            id,
            codeGraphId: GRAPH,
            projectId: P,
            kind: "function",
            name,
            qualifiedName: `${filePath}::${name}`,
            filePath,
            startLine: 1,
            endLine: 3,
            language: "ts",
            contentHash: id,
          },
        });
      }
      const doc = (id: string, filename: string, source: string, aclSubjects = "[]") =>
        db.document.create({
          data: {
            id,
            projectId: P,
            filename,
            source,
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: `/tmp/${id}`,
            checksum: id,
            uploadedById: "alice",
            status: "ready",
            aclSubjects,
          },
        });
      await doc("d-fee", `connector:repo:${REPO}:src/src/fee.ts`, "repo");
      await doc(
        "d-vault",
        `connector:repo:${REPO}:src/src/vault.ts`,
        "repo",
        JSON.stringify([{ kind: "user", value: "alice" }]),
      );
      await doc("d-brief", "brief.md", "upload");
      cloneRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2448-"));
      mkdirSync(path.join(cloneRoot, REPO, "src"), { recursive: true });
      writeFileSync(
        path.join(cloneRoot, REPO, "src", "fee.ts"),
        "export function computeFee() {\n  return 1;\n}\n",
      );
      writeFileSync(
        path.join(cloneRoot, REPO, "src", "vault.ts"),
        `export function vaultKey() {\n  return "${SECRET_MARK}";\n}\n`,
      );
      process.env.REPO_CLONE_DIR = cloneRoot;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
      if (savedCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
      else process.env.REPO_CLONE_DIR = savedCloneDir;
    });

    for (const [name, run] of Object.entries(paths)) {
      describe(`the ${name} path`, () => {
        it("Alice's run uses her restricted file; Bob sees a placeholder, Alice and an admin see the finding", async () => {
          const id = await startRun("alice");
          expect((await db.analysis.findUniqueOrThrow({ where: { id } })).sourceAccess).toBe(
            "starter",
          );
          const { orch, prompts } = orchestrator();
          await run(orch, id, "alice");

          // The pass read the restricted file with Alice's access.
          expect(prompts()).toContain("src/vault.ts");
          // It is recorded on the pass, and on the finding that cites only fee.ts.
          const stored = await finding(id);
          expect(stored.read).toBe(JSON.stringify({ documentIds: ["d-vault"], chunkIds: [] }));
          expect(stored.sources.documentIds).toEqual(["d-fee", "d-vault"]);
          expect(stored.sources.citations).toEqual([{ documentIds: ["d-fee"], chunkIds: [] }]);

          const bob = await snapshotAs("bob", id);
          const bobFinding = bob.agents[0]!.findings[0]!;
          expect(bobFinding.title).toBe(RESTRICTED_SOURCE_TITLE);
          expect(bobFinding.restricted).toBe(true);
          expect(bob.agents[0]!.summary).toBeNull();
          expect(JSON.stringify(bob)).not.toContain(FINDING_TITLE);
          // Everyone is told how many restricted files the run read, never which.
          expect(bob.capability?.restrictedRead).toBe(1);
          expect(JSON.stringify(bob)).not.toMatch(/vault/i);

          for (const who of ["alice", "root"] as const) {
            const seen = await snapshotAs(who, id);
            expect(seen.agents[0]!.findings[0]!.title, who).toBe(FINDING_TITLE);
            expect(seen.agents[0]!.summary, who).toBe("Read the fee code.");
          }
        });

        it("Bob's run never reads Alice's file, so Bob sees his finding", async () => {
          const id = await startRun("bob");
          const { orch, prompts } = orchestrator();
          await run(orch, id, "bob");
          expect(prompts()).not.toContain("src/vault.ts");
          const stored = await finding(id);
          expect(stored.read).toBe(JSON.stringify({ documentIds: [], chunkIds: [] }));
          expect(stored.sources.documentIds).toEqual(["d-fee"]);
          const bob = await snapshotAs("bob", id);
          expect(bob.agents[0]!.findings[0]!.title).toBe(FINDING_TITLE);
          expect(bob.agents[0]!.summary).toBe("Read the fee code.");
          expect(bob.capability?.restrictedRead).toBeUndefined();
        });
      });
    }

    it("a scheduled run reads as the shared audience, as before #2448", async () => {
      const id = await startRun("system");
      expect((await db.analysis.findUniqueOrThrow({ where: { id } })).sourceAccess).toBe("shared");
      const { orch, prompts } = orchestrator();
      // Even with a person named on the pass: the run's marker decides.
      await paths.agentic!(orch, id, "alice");
      expect(prompts()).not.toContain("src/vault.ts");
      const stored = await finding(id);
      expect(stored.read).toBeNull();
      expect(stored.sources.documentIds).toEqual(["d-fee"]);
      expect((await snapshotAs("bob", id)).agents[0]!.findings[0]!.title).toBe(FINDING_TITLE);
    });

    it("Bob regenerating Alice's run reads with his own access, and sees his own result", async () => {
      const id = await startRun("alice");
      await paths.agentic!(orchestrator().orch, id, "alice");
      expect((await finding(id)).sources.documentIds).toContain("d-vault");

      const { orch, prompts } = orchestrator();
      await orch.regenerateAgent!({
        analysisId: id,
        agentKey: "code",
        actorId: "bob",
      });
      expect(prompts()).not.toContain("src/vault.ts");
      // The code pass it replaced was not its input, so it rests on nothing of Alice's.
      const stored = await finding(id);
      expect(stored.sources.documentIds).toEqual(["d-fee"]);
      expect((await snapshotAs("bob", id)).agents[0]!.findings[0]!.title).toBe(FINDING_TITLE);
    });

    it("re-synthesis after Bob's regenerate keeps what Alice's pass read: an approved requirement still rests on it", async () => {
      const id = await startRun("alice");
      await paths.agentic!(orchestrator().orch, id, "alice");
      // Synthesis over Alice's findings (outside any pass), and the requirement
      // it wrote, which a person then approved: kept through a regenerate (#769).
      const synthesise = () =>
        persistAgentResult({
          analysisId: id,
          agentKey: "synthesis",
          status: "completed",
          output: null,
          startedAt: new Date(),
          completedAt: new Date(),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        });
      await synthesise();
      await db.requirement.create({
        data: {
          analysisId: id,
          projectId: P,
          title: "Keys are rotated",
          body: "b",
          reviewStatus: "approved",
          sourceIds: null,
        },
      });
      const vaultOnly = JSON.stringify({ documentIds: ["d-vault"], chunkIds: [] });

      const { orch, prompts } = orchestrator();
      await orch.regenerateAgent!({
        analysisId: id,
        agentKey: "code",
        actorId: "bob",
      });
      expect(prompts()).not.toContain("src/vault.ts");
      await synthesise();
      // The pass that read Alice's file is gone; the synthesis that read its
      // findings still records it, so the run's corpus never shrinks.
      const synthesis = await db.agentResult.findFirstOrThrow({
        where: { analysisId: id, agentKey: "synthesis" },
      });
      expect(synthesis.readSourceIds).toBe(vaultOnly);
      expect((await snapshotAs("bob", id)).requirements[0]!.title).toBe(RESTRICTED_SOURCE_TITLE);
      expect((await snapshotAs("alice", id)).requirements[0]!.title).toBe("Keys are rotated");
      // Fail closed: a regenerate after synthesis counts the synthesis among
      // its inputs, so Bob's new finding rests on Alice's file too.
      expect((await finding(id)).read).toBe(vaultOnly);
    });

    it("fails closed when an earlier pass recorded no read set: the next pass's finding has no record", async () => {
      const id = await startRun("bob");
      // An earlier pass whose read set is unknown (as a rollback would leave it).
      await db.agentResult.create({
        data: { analysisId: id, agentKey: "document", status: "completed", readSourceIds: null },
      });
      await paths.agentic!(orchestrator().orch, id, "bob");
      const row = await db.finding.findFirstOrThrow({
        where: { agentResult: { analysisId: id } },
        select: { sourceIds: true, agentResult: { select: { readSourceIds: true } } },
      });
      expect(row.sourceIds).toBeNull();
      expect(row.agentResult?.readSourceIds).toBeNull();
      // It may rest on anything the project holds: only a reader who can see all of it.
      expect((await snapshotAs("bob", id)).agents.at(-1)!.findings[0]!.title).toBe(
        RESTRICTED_SOURCE_TITLE,
      );
      expect((await snapshotAs("alice", id)).agents.at(-1)!.findings[0]!.title).toBe(FINDING_TITLE);
    });

    it("a requirement synthesised on Alice's run rests on the run as a whole", async () => {
      const id = await startRun("alice");
      await paths.agentic!(orchestrator().orch, id, "alice");
      const findingId = (
        await db.finding.findFirstOrThrow({
          where: { agentResult: { analysisId: id } },
          select: { id: true },
        })
      ).id;
      await persistRequirements({
        analysisId: id,
        projectId: P,
        synthesis: {
          summary: "s",
          requirements: [
            {
              type: "feature",
              title: "Fees are computed once",
              body: "b",
              priority: "medium",
              labels: [],
              evidenceFindingIndexes: [0],
              acceptanceCriteria: [],
            },
          ],
        } as unknown as SynthesisOutput,
        findingIdsByIndex: [findingId],
      });
      // Synthesis read every finding, so the row has no record of its own.
      const row = await db.requirement.findFirstOrThrow({ where: { analysisId: id } });
      expect(row.sourceIds).toBeNull();
      expect((await snapshotAs("bob", id)).requirements[0]!.title).toBe(RESTRICTED_SOURCE_TITLE);
      expect((await snapshotAs("alice", id)).requirements[0]!.title).toBe("Fees are computed once");
    });
  },
);
