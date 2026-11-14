/**
 * #2506 (epic #2438) — an analysis a person starts reads DOCUMENTS with their
 * access too, records each restricted one a pass read, and every reader sees
 * what they may. End to end over a REAL SQLite database built by the
 * migration chain, the REAL orchestrator code paths, the real
 * `persistAgentResult` and the real snapshot read with the #2447 filter.
 *
 * Fixture: two uploads, `doc-brief-2506` (open) and `doc-memo-2506`, which
 * Alice alone may read. The knowledge search, the document reader's loader
 * and the quarantine table hold a passage of each; the search and the loader
 * apply the actor's access, as LanceDB's filter and the production loader do.
 * Every model answer cites only the open brief: a finding written after
 * reading the memo, citing the brief, is what the read set must catch.
 *
 * For each document read of a pass (the document reader, grounded retrieval,
 * the quarantine fallback, per-requirement retrieval over the default
 * selection, and the code agent's `search_knowledge`):
 *   - Alice's run reads the memo with her access, records it on the pass and
 *     on its finding: Bob sees the placeholder, Alice and an admin the finding;
 *   - Bob's run never reads it, and Bob sees his finding;
 *   - a scheduled run reads as the shared audience, as before.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { RESTRICTED_SOURCE_TITLE, type AclSubject } from "@metis/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { AclActor } from "../src/lib/rag/acl.js";
import type { ReaderDocumentLoader } from "../src/lib/analysis/document-reader-agent.js";
import type { RequirementCodeMatch } from "../src/lib/traceability/requirement-code-mapping.js";

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
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));

const { createAnalysis, getAnalysisSnapshot } =
  await import("../src/lib/analysis/analysis-service.js");
const { userSourceReader } = await import("../src/lib/analysis/source-redaction.js");
const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { isVisibleTo } = await import("../src/lib/rag/acl.js");
const { __resetConfigSingleton } = await import("../src/lib/config/config-service.js");
const { createCapabilityTracker, finalizeCapability } =
  await import("../src/lib/analysis/analysis-capability.js");
const { InMemoryCodeGraphDataSource } =
  await import("../src/lib/impact-analysis/impact-analysis-engine.js");

const P = "p-2506-docs";
const REPO = "rc-2506-docs";
const GRAPH = "g-2506-docs";
const BRIEF = "doc-brief-2506";
const MEMO = "doc-memo-2506";
const OPEN_TEXT = "Invoices are issued monthly.";
const SECRET_TEXT = "MERGER_2506 closes in March.";
const FINDING_TITLE = "Invoices go out monthly";

type Who = "alice" | "bob" | "root";
const ROLES: Record<Who, string> = { alice: "coordinator", bob: "coordinator", root: "admin" };
const ACL: Record<string, AclSubject[]> = {
  [BRIEF]: [],
  [MEMO]: [{ kind: "user", value: "alice" }],
};
const TEXT: Record<string, string> = { [BRIEF]: OPEN_TEXT, [MEMO]: SECRET_TEXT };
const FILENAME: Record<string, string> = { [BRIEF]: "brief.md", [MEMO]: "merger.md" };
const sees = (documentId: string, actor: AclActor) =>
  isVisibleTo({ subjects: ACL[documentId] ?? [] }, actor);

interface Stored {
  documentIds: string[];
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2506 — analyses read documents with the starter's access, and readers see what they may (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let cloneRoot: string;
    const savedCloneDir = process.env.REPO_CLONE_DIR;
    /** The actor of every knowledge search, in order. */
    const searchedAs: AclActor[] = [];

    const finding = {
      category: "requirement",
      severity: "info",
      title: FINDING_TITLE,
      body: "The brief bills monthly.",
      requirementId: "REQ-1",
      // Cites the OPEN brief only, whatever else the pass read.
      citations: [{ documentId: BRIEF, chunkIndex: 0 }],
    };
    const answer = (agentKey: string) =>
      JSON.stringify({ agentKey, summary: "Read the brief.", notes: [], findings: [finding] });
    /** The document reader's reply: the one statement of the document it was shown. */
    const readerReply = (prompt: string) => {
      const quote = prompt.includes(SECRET_TEXT) ? SECRET_TEXT : OPEN_TEXT;
      return JSON.stringify({
        statements: [{ section: "S2", kind: "requirement", statement: quote, quote }],
      });
    };

    /** A knowledge search that, as LanceDB's filter does, returns only what the actor may read. */
    const knowledge = (empty = false) => ({
      search: vi.fn(
        async (
          _projectId: string,
          _query: string,
          opts: { actor?: AclActor; documentIds?: string[] },
        ) => {
          searchedAs.push(opts.actor!);
          const ids = (opts.documentIds ?? [BRIEF, MEMO]).filter((id) => id in TEXT);
          const visible = empty ? [] : ids.filter((id) => sees(id, opts.actor!));
          return {
            hits: visible.map((documentId, i) => ({
              chunkId: `${documentId}-c0`,
              documentId,
              position: 0,
              filename: FILENAME[documentId]!,
              text: TEXT[documentId]!,
              score: 0.9 - i / 10,
              source: "upload",
            })),
            aclMismatch: ids.filter((id) => !sees(id, opts.actor!)).map((id) => `${id}-c0`),
            mode: "hybrid",
          };
        },
      ),
    });
    /** The reader's loader: the selected documents the actor may read, as the production one. */
    const readerDocuments: ReaderDocumentLoader = async (_projectId, ids, actor) =>
      ids.map((documentId) =>
        sees(documentId, actor) && TEXT[documentId]
          ? {
              ok: true as const,
              document: {
                documentId,
                filename: FILENAME[documentId]!,
                title: FILENAME[documentId]!,
                text: `# ${FILENAME[documentId]}\n\n## 1 Terms\n\n${TEXT[documentId]}\n`,
                chunks: [{ index: 0, text: TEXT[documentId]! }],
              },
            }
          : {
              ok: false as const,
              documentId,
              filename: documentId,
              reason: "It is not available to read.",
              unavailable: true as const,
            },
      );

    type Orch = Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
    /** The orchestrator, and every prompt its model was sent. */
    const orchestrator = (opts: { emptySearch?: boolean } = {}) => {
      const prompts: string[] = [];
      let loopTurns = 0;
      const orch = new AnalysisOrchestrator({
        provider: {
          key: "offline-stub",
          model: "stub",
          offline: true,
          chat: vi.fn(
            async (
              messages: Array<{ content: string }>,
              chatOpts?: { systemMessage?: string; callType?: string },
            ) => {
              const prompt = JSON.stringify(messages);
              prompts.push(prompt);
              const system = chatOpts?.systemMessage ?? "";
              let content = answer("document");
              if (system.includes("from beginning to end")) content = readerReply(prompt);
              else if (system.includes("combining the statements")) {
                content = JSON.stringify({ duplicates: [], crossReferences: [] });
              } else if (chatOpts?.callType === "agent-loop") {
                // The agentic code agent searches the documents once, then answers.
                content =
                  ++loopTurns === 1
                    ? JSON.stringify({ tool: "search_knowledge", args: { query: "merger" } })
                    : answer("code");
              } else if (prompt.includes("REQ-1")) content = answer("code");
              return {
                content,
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                model: "stub",
                provider: "offline-stub",
              };
            },
          ),
        } as never,
        knowledge: knowledge(opts.emptySearch) as never,
        readerDocuments,
        fusedCode: {
          searcher: { search: async () => [] },
          lineLookup: { resolve: async () => new Map() },
        },
        prepareRepoClone: async () => "healthy",
      }) as unknown as Orch;
      orch.runSynthesisAndPersist = vi.fn(async () => undefined);
      return { orch, prompts: () => prompts.join("\n") };
    };
    const common = (analysisId: string, actorId: string) => ({
      analysisId,
      projectId: P,
      projectName: "Billing",
      projectDescription: "billing",
      signal: new AbortController().signal,
      actorId,
    });
    const REQUIREMENTS = [{ id: "REQ-1", text: "Bill customers monthly." }];
    const paths: Record<
      string,
      {
        agentKey: string;
        run: (orch: Orch, id: string, actorId: string) => Promise<unknown>;
        reader?: true;
        emptySearch?: true;
      }
    > = {
      "the document reader (no document selected)": {
        agentKey: "document",
        reader: true,
        run: (orch, id, actorId) =>
          orch.runOneAgent!({ ...common(id, actorId), agentKey: "document", documentIds: [] }),
      },
      "grounded retrieval": {
        agentKey: "document",
        run: (orch, id, actorId) =>
          orch.runOneAgent!({
            ...common(id, actorId),
            agentKey: "document",
            documentIds: [BRIEF, MEMO],
          }),
      },
      "the quarantine fallback": {
        agentKey: "document",
        emptySearch: true,
        run: (orch, id, actorId) =>
          orch.runOneAgent!({
            ...common(id, actorId),
            agentKey: "document",
            documentIds: [BRIEF, MEMO],
          }),
      },
      "per-requirement retrieval over the default selection": {
        agentKey: "code",
        run: (orch, id, actorId) =>
          orch.runRequirementGroundedCodeAgent!({
            ...common(id, actorId),
            requirements: REQUIREMENTS,
          }),
      },
      "the code agent's search_knowledge": {
        agentKey: "code",
        run: (orch, id, actorId) =>
          orch.runAgenticCodeAgent!({
            ...common(id, actorId),
            requirements: REQUIREMENTS,
            connectorId: REPO,
          }),
      },
    };

    /** A run, as `createAnalysis` writes it for `startedById`. */
    const startRun = async (startedById: string) => {
      const run = await createAnalysis({
        projectId: P,
        startedById,
        agentKeys: ["document", "code"],
        documentIds: [],
        title: "Billing",
      });
      await db.analysis.update({ where: { id: run.id }, data: { status: "completed" } });
      return run.id;
    };
    const stored = async (analysisId: string, agentKey: string) => {
      const row = await db.agentResult.findFirstOrThrow({
        where: { analysisId, agentKey },
        select: { readSourceIds: true, findings: { select: { sourceIds: true } } },
      });
      return {
        read: row.readSourceIds,
        sources: row.findings.map((f) => (JSON.parse(f.sourceIds!) as Stored).documentIds),
      };
    };
    const snapshotAs = async (who: Who, analysisId: string, agentKey: string) => {
      const snapshot = (await getAnalysisSnapshot(analysisId, {
        reader: userSourceReader(who),
      }))!;
      return { snapshot, agent: snapshot.agents.find((a) => a.agentKey === agentKey)! };
    };
    const memoOnly = JSON.stringify({ documentIds: [MEMO], chunkIds: [] });
    const nothing = JSON.stringify({ documentIds: [], chunkIds: [] });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("starter-document-access-2506");
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
      for (const id of [BRIEF, MEMO]) {
        await db.document.create({
          data: {
            id,
            projectId: P,
            filename: FILENAME[id]!,
            source: "upload",
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: `/tmp/${id}`,
            checksum: id,
            uploadedById: "alice",
            status: "ready",
            aclSubjects: JSON.stringify(ACL[id]),
          },
        });
        await db.quarantineChunk.create({
          data: {
            id: `${id}-q0`,
            documentId: id,
            projectId: P,
            ord: 0,
            text: TEXT[id]!,
            embedding: "[]",
          },
        });
      }
      cloneRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2506-"));
      mkdirSync(path.join(cloneRoot, REPO, "src"), { recursive: true });
      writeFileSync(path.join(cloneRoot, REPO, "src", "bill.ts"), "export const bill = 1;\n");
      process.env.REPO_CLONE_DIR = cloneRoot;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      searchedAs.length = 0;
      delete process.env.ANALYSIS_DOCUMENT_READER;
      __resetConfigSingleton();
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
      if (savedCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
      else process.env.REPO_CLONE_DIR = savedCloneDir;
    });

    const prepare = (path: (typeof paths)[string]) => {
      if (path.reader) {
        process.env.ANALYSIS_DOCUMENT_READER = "true";
        __resetConfigSingleton();
      }
      return orchestrator({ emptySearch: path.emptySearch });
    };

    for (const [name, path] of Object.entries(paths)) {
      describe(name, () => {
        it("Alice's run reads her restricted document and records it; Bob sees a placeholder, Alice and an admin the finding", async () => {
          const id = await startRun("alice");
          const { orch, prompts } = prepare(path);
          await path.run(orch, id, "alice");

          // The pass read the memo with Alice's access...
          expect(prompts()).toContain("MERGER_2506");
          if (searchedAs.length > 0)
            expect(searchedAs.every((a) => a.userId === "alice")).toBe(true);
          expect(searchedAs.some((a) => a.sharedAudience)).toBe(false);
          // ...recorded it on the pass, and on its finding that cites only the brief.
          const row = await stored(id, path.agentKey);
          expect(row.read).toBe(memoOnly);
          expect(row.sources.length).toBeGreaterThan(0);
          for (const s of row.sources) expect(s).toContain(MEMO);

          const bob = await snapshotAs("bob", id, path.agentKey);
          expect(bob.agent.findings.every((f) => f.restricted)).toBe(true);
          expect(bob.agent.summary).toBeNull();
          expect(JSON.stringify(bob.snapshot)).not.toContain("MERGER_2506");
          expect(bob.snapshot.capability?.restrictedRead ?? 1).toBe(1);
          for (const who of ["alice", "root"] as const) {
            const seen = await snapshotAs(who, id, path.agentKey);
            expect(
              seen.agent.findings.some((f) => !f.restricted),
              who,
            ).toBe(true);
            expect(seen.agent.summary, who).not.toBeNull();
          }
        });

        it("Bob's run never reads it, so Bob sees his finding", async () => {
          const id = await startRun("bob");
          const { orch, prompts } = prepare(path);
          await path.run(orch, id, "bob");
          expect(prompts()).not.toContain("MERGER_2506");
          expect(searchedAs.every((a) => a.userId === "bob" && !a.sharedAudience)).toBe(true);
          const row = await stored(id, path.agentKey);
          expect(row.read).toBe(nothing);
          for (const s of row.sources) expect(s).not.toContain(MEMO);
          const bob = await snapshotAs("bob", id, path.agentKey);
          expect(bob.agent.findings.some((f) => !f.restricted)).toBe(true);
          expect(bob.agent.summary).not.toBeNull();
        });
      });
    }

    it("a scheduled run reads documents as the shared audience, as before #2506", async () => {
      const id = await startRun("system");
      const path = paths["grounded retrieval"]!;
      const { orch, prompts } = prepare(path);
      // Even with a person named on the pass: the run's marker decides.
      await path.run(orch, id, "alice");
      expect(prompts()).not.toContain("MERGER_2506");
      expect(searchedAs.every((a) => a.sharedAudience)).toBe(true);
      expect((await stored(id, "document")).read).toBeNull();
      const bob = await snapshotAs("bob", id, "document");
      expect(bob.agent.findings.some((f) => f.title === FINDING_TITLE)).toBe(true);
    });

    it("what Alice's document pass read hides the code pass after it from Bob, though the code read nothing restricted", async () => {
      const id = await startRun("alice");
      const { orch } = prepare(paths["grounded retrieval"]!);
      await paths["grounded retrieval"]!.run(orch, id, "alice");
      // Bob runs the next pass: he reads nothing restricted, but its input
      // (the document pass's output) rests on Alice's memo.
      const next = orchestrator();
      await next.orch.runRequirementGroundedCodeAgent!({
        ...common(id, "bob"),
        requirements: REQUIREMENTS,
      });
      expect((await stored(id, "code")).read).toBe(memoOnly);
      const bob = await snapshotAs("bob", id, "code");
      expect(bob.agent.findings.every((f) => f.title === RESTRICTED_SOURCE_TITLE)).toBe(true);
    });

    it("Bob regenerating Alice's document pass sees his own finding, and still none of what her pass shaped on the run", async () => {
      const id = await startRun("alice");
      const path = paths["grounded retrieval"]!;
      await path.run(prepare(path).orch, id, "alice");
      // What the enhancement pipeline wrote from Alice's reading, run-wide.
      const run = await db.analysis.findUniqueOrThrow({ where: { id } });
      await db.analysis.update({
        where: { id },
        data: {
          metadata: JSON.stringify({
            ...JSON.parse(run.metadata ?? "{}"),
            structuredRequirements: {
              requirements: [{ id: "REQ-1", title: SECRET_TEXT, description: SECRET_TEXT }],
              totalAmbiguities: 0,
              totalEvidenceNeeds: 0,
            },
            webResearch: { digests: [{ id: "d1", summary: SECRET_TEXT }] },
          }),
        },
      });

      // Bob runs the document pass again: it replaces Alice's, and no
      // synthesis row remembers what hers read.
      const { orch, prompts } = prepare(path);
      await path.run(orch, id, "bob");
      expect(prompts()).not.toContain("MERGER_2506");
      expect(await db.agentResult.count({ where: { analysisId: id } })).toBe(1);
      const kept = JSON.parse(
        (await db.analysis.findUniqueOrThrow({ where: { id } })).metadata ?? "{}",
      ) as Record<string, unknown>;
      expect(kept.replacedReadSourceIds).toEqual([MEMO]);

      const bob = await snapshotAs("bob", id, "document");
      // His own finding rests only on what he read...
      expect(bob.agent.findings.some((f) => f.title === FINDING_TITLE)).toBe(true);
      // ...but the run-wide records Alice's reading shaped stay hidden from him.
      expect(JSON.stringify(bob.snapshot)).not.toContain("MERGER_2506");
      expect(bob.agent.summary).toBeNull();
      const alice = await snapshotAs("alice", id, "document");
      expect(JSON.stringify(alice.snapshot.metadata)).toContain("MERGER_2506");
    });

    it("the affected-code links of a starter run still name no restricted file, and count nothing left out", async () => {
      const secretFile = "doc-repo-secret-2506";
      await db.document.create({
        data: {
          id: secretFile,
          projectId: P,
          filename: `connector:repo:${REPO}:src/src/billing/secret.ts`,
          source: "repo",
          mimeType: "text/plain",
          sizeBytes: 1,
          storagePath: `/tmp/${secretFile}`,
          checksum: secretFile,
          uploadedById: "alice",
          status: "ready",
          aclSubjects: JSON.stringify(ACL[MEMO]),
        },
      });
      try {
        const matches: RequirementCodeMatch[] = [
          {
            codeSymbolId: "s-secret",
            filePath: "src/billing/secret.ts",
            qualifiedName: "SecretPricing.rate",
            startLine: 3,
            endLine: 9,
            confidence: 0.95,
          },
          {
            codeSymbolId: "s-open",
            filePath: "src/billing/invoice.ts",
            qualifiedName: "InvoiceService.charge",
            startLine: 20,
            endLine: 40,
            confidence: 0.9,
          },
        ];
        const affected = async (startedBy: string) => {
          const id = await startRun(startedBy);
          const orch = new AnalysisOrchestrator({
            provider: { key: "stub", model: "stub", offline: true } as never,
            affectedCode: {
              mapRequirement: async () => matches,
              dataSourceFor: () => new InMemoryCodeGraphDataSource([], []),
            },
          }) as unknown as {
            capabilities: Map<string, ReturnType<typeof createCapabilityTracker>>;
            computeAffectedCode(a: string, p: string, x: string): Promise<{ filePaths: string[] }>;
          };
          const tracker = createCapabilityTracker({
            static: {
              codeGraphPresent: true,
              repoSourceIngested: true,
              fusedCodeRetrievalEnabled: true,
              schemaContextEnabled: true,
            },
            codeAnalysisRequested: true,
            databaseAnalysisRequested: false,
          });
          orch.capabilities.set(id, tracker);
          const ctx = await orch.computeAffectedCode(id, P, "Add a monthly invoice charge.");
          return { ctx, left: finalizeCapability(tracker).restrictedLeftOut };
        };
        // Alice's run: the links are read by the whole project, so the file
        // is left out of them, but the run's passes read with her access: the
        // run does not say it "left restricted files out".
        const alice = await affected("alice");
        expect(alice.ctx.filePaths).toEqual(["src/billing/invoice.ts"]);
        expect(alice.left).toBeUndefined();
        // Positive control: a scheduled run reads as the shared audience and says so.
        const scheduled = await affected("system");
        expect(scheduled.ctx.filePaths).toEqual(["src/billing/invoice.ts"]);
        expect(scheduled.left).toEqual({ reason: "shared-audience", files: 1, symbols: 0 });
      } finally {
        await db.document.delete({ where: { id: secretFile } });
      }
    });
  },
);
