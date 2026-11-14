/**
 * #2431 — an analysis's document reads honour document ACLs as a shared
 * audience, over a real SQLite database built by the migration chain.
 *
 * `d-secret` is an upload restricted to its owner, Alice; `d-open` is not.
 * Alice starts every run here, and still none of them reads `d-secret`: an
 * analysis's findings are read by every project member (the rule #2314 chose
 * for code). The paths, each named in the issue:
 *   - the default selection (`defaultAnalysisDocumentIds`);
 *   - the single-shot code agent's requirement and code halves, the specialist
 *     agents' retrieval (`runGroundedRetrieval`) and the quarantine fallback;
 *   - the requirement-grounded code agent (`retrievePerRequirement`);
 *   - the agentic code agent's `search_knowledge` tool;
 *   - the affected-code seed (#735), which names no restricted repository file.
 * What the searches drop is counted on the run's capability record
 * (`restrictedLeftOut.documentChunks`), counts only, and a regenerate keeps
 * the stored code counts.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RetrievedChunk } from "@metis/shared";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { SearchOptions } from "../src/lib/rag/knowledge-service.js";
import type { RequirementCodeMatch } from "../src/lib/traceability/requirement-code-mapping.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
    resolveDatabaseProvider: () => "sqlite",
  };
});
vi.mock("../src/lib/analysis/analysis-service.js", async (original) => ({
  ...(await original<typeof import("../src/lib/analysis/analysis-service.js")>()),
  persistAgentResult: vi.fn(async () => ({ id: "ar-2431", findingIds: [] })),
}));
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));

const { AnalysisOrchestrator, assembleAgenticCodeTools, defaultAnalysisDocumentIds } =
  await import("../src/lib/analysis/orchestrator.js");
const { createCapabilityTracker, finalizeCapability } =
  await import("../src/lib/analysis/analysis-capability.js");
const { getAnalysisCapability, getAnalysisSnapshot, persistAnalysisCapability } =
  await import("../src/lib/analysis/analysis-service.js");
const { filterAccessible, parseAclSubjects } = await import("../src/lib/rag/acl.js");
const { InMemoryCodeGraphDataSource } =
  await import("../src/lib/impact-analysis/impact-analysis-engine.js");

const ALICE = "u-alice";
const PROJECT = "p-2431";
const REPO = "rc-2431";
const SECRET_TEXT = "SECRET: the merger closes on 1 March";
const OPEN_TEXT = "Invoices are issued monthly";
const ANSWER = JSON.stringify({ agentKey: "code", summary: "done", findings: [], notes: [] });

type Orch = {
  capabilities: Map<string, ReturnType<typeof createCapabilityTracker>>;
  regenRestrictedLeftOut: Map<string, { checked: boolean; counts: Record<string, unknown> }>;
} & Record<string, (...args: never[]) => Promise<unknown>>;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2431 — analysis document reads as a shared audience (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const restrict = (subjects: Array<{ kind: string; value: string }>) =>
      db.document.update({
        where: { id: "d-secret" },
        data: { aclSubjects: JSON.stringify(subjects) },
      });

    /**
     * A knowledge service that filters as `KnowledgeService.search` does, on
     * each chunk's document's ACL as stored now: by the actor when one is
     * passed, reporting the denied chunk ids when asked.
     */
    const searches: SearchOptions[] = [];
    const knowledge = {
      search: vi.fn(async (_projectId: string, _query: string, opts: SearchOptions = {}) => {
        searches.push(opts);
        const docs = await db.document.findMany({
          where: { projectId: PROJECT, id: { in: ["d-open", "d-secret"] } },
          select: { id: true, aclSubjects: true },
        });
        const acl = new Map(docs.map((d) => [d.id, parseAclSubjects(d.aclSubjects)]));
        let pool = [
          { id: "c-open-0", doc: "d-open", text: OPEN_TEXT },
          { id: "c-secret-0", doc: "d-secret", text: SECRET_TEXT },
        ]
          .filter((c) => !opts.documentIds || opts.documentIds.includes(c.doc))
          .map((c) => ({
            chunkId: c.id,
            documentId: c.doc,
            filename: `${c.doc}.md`,
            position: 0,
            text: c.text,
            score: 0.9,
            source: "upload" as const,
            aclSubjects: acl.get(c.doc) ?? [],
          }));
        let aclMismatch: string[] | undefined;
        if (opts.actor) {
          const { allowed, deniedChunkIds } = filterAccessible(pool, opts.actor);
          pool = allowed;
          if (opts.reportAclMismatch && deniedChunkIds.length > 0) aclMismatch = deniedChunkIds;
        }
        return {
          hits: pool.map(({ aclSubjects: _a, ...h }) => h as RetrievedChunk),
          mode: "hybrid" as const,
          ...(aclMismatch ? { aclMismatch } : {}),
        };
      }),
    };
    const noHits = { search: vi.fn(async () => ({ hits: [], mode: "hybrid" as const })) };

    const orchestrator = (seen: string[] = [], over: Record<string, unknown> = {}): Orch =>
      new AnalysisOrchestrator({
        provider: {
          key: "offline-stub",
          model: "stub",
          offline: true,
          chat: vi.fn(
            async (messages: Array<{ content: unknown }>, opts?: { systemMessage?: string }) => {
              if (typeof opts?.systemMessage === "string") seen.push(opts.systemMessage);
              for (const m of messages) if (typeof m.content === "string") seen.push(m.content);
              return {
                content: ANSWER,
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                model: "stub",
                provider: "offline-stub",
              };
            },
          ),
        } as never,
        knowledge: knowledge as never,
        // No code graph here: the fused seed finds nothing.
        fusedCode: {
          searcher: { search: async () => [] },
          lineLookup: { resolve: async () => new Map() },
        },
        ...over,
      }) as unknown as Orch;

    /** An orchestrator with a capability tracker for `analysisId`, as a pipeline run has. */
    const withTracker = async (analysisId: string, seen: string[] = []) => {
      await db.analysis.upsert({
        where: { id: analysisId },
        create: { id: analysisId, projectId: PROJECT, status: "completed", startedById: ALICE },
        update: { metadata: null },
      });
      const orch = orchestrator(seen);
      const tracker = createCapabilityTracker({
        static: {
          codeGraphPresent: false,
          repoSourceIngested: true,
          fusedCodeRetrievalEnabled: true,
          schemaContextEnabled: true,
        },
        codeAnalysisRequested: true,
        databaseAnalysisRequested: false,
      });
      orch.capabilities.set(analysisId, tracker);
      const capability = async () => {
        await persistAnalysisCapability(analysisId, finalizeCapability(tracker));
        const read = await getAnalysisCapability(analysisId);
        expect((await getAnalysisSnapshot(analysisId))?.capability).toEqual(read);
        const row = await db.analysis.findUniqueOrThrow({ where: { id: analysisId } });
        return { read: read!, stored: row.metadata ?? "" };
      };
      return { orch, capability };
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("analysis-document-access-2431");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: ALICE, username: "alice", displayName: "alice", email: "alice@example.test" },
      });
      await db.project.create({
        data: { id: PROJECT, name: "Billing", slug: PROJECT, createdById: ALICE },
      });
      const doc = (id: string, filename: string, source: string, aclSubjects = "[]") =>
        db.document.create({
          data: {
            id,
            projectId: PROJECT,
            filename,
            source,
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: `/tmp/${id}`,
            checksum: id,
            uploadedById: ALICE,
            status: "ready",
            aclSubjects,
          },
        });
      await doc("d-open", "open.md", "upload");
      await doc(
        "d-secret",
        "merger.md",
        "upload",
        JSON.stringify([{ kind: "user", value: ALICE }]),
      );
      // A repository file restricted to Alice, for the affected-code seed
      // (ingested as `src/<repo-relative path>`).
      await doc(
        "d-repo-secret",
        `connector:repo:${REPO}:src/src/billing/secret.ts`,
        "repo",
        JSON.stringify([{ kind: "user", value: ALICE }]),
      );
      for (const [id, documentId, text] of [
        ["q-open", "d-open", OPEN_TEXT],
        ["q-secret", "d-secret", SECRET_TEXT],
      ] as const) {
        await db.quarantineChunk.create({
          data: { id, documentId, projectId: PROJECT, ord: 0, text, embedding: "[]" },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      searches.length = 0;
      await restrict([{ kind: "user", value: ALICE }]);
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the default selection leaves a restricted upload out, and takes it once the restriction is lifted", async () => {
      expect(await defaultAnalysisDocumentIds(PROJECT)).toEqual(["d-open"]);
      await restrict([]);
      expect((await defaultAnalysisDocumentIds(PROJECT)).sort()).toEqual(["d-open", "d-secret"]);
    });

    describe("single-shot and specialist retrieval", () => {
      it("never reads a restricted upload, selected or not, and counts what it dropped", async () => {
        const id = "an-2431-ss";
        const { orch, capability } = await withTracker(id);
        const code = (await orch.retrieveContext!({
          analysisId: id,
          projectId: PROJECT,
          agentKey: "code",
          projectName: "Billing",
          projectDescription: "invoices",
        } as never)) as Array<{ text: string }>;
        const doc = (await orch.retrieveContext!({
          analysisId: id,
          projectId: PROJECT,
          agentKey: "document",
          documentIds: ["d-open", "d-secret"],
        } as never)) as Array<{ text: string }>;
        for (const chunks of [code, doc]) {
          expect(chunks.map((c) => c.text)).toContain(OPEN_TEXT);
          expect(chunks.map((c) => c.text)).not.toContain(SECRET_TEXT);
        }
        expect(searches.length).toBeGreaterThan(0);
        for (const opts of searches) {
          expect(opts.actor).toEqual({
            userId: "system",
            role: "shared-audience",
            sharedAudience: true,
          });
        }
        const { read, stored } = await capability();
        // One restricted chunk, dropped by several searches, counts once; the
        // code half also read code, so the restricted repository file counts (#2437).
        expect(read.restrictedLeftOut).toEqual({
          reason: "shared-audience",
          files: 1,
          symbols: 0,
          documentChunks: 1,
        });
        for (const named of ["c-secret-0", "d-secret", "merger", "SECRET"]) {
          expect(stored).not.toContain(named);
        }
      });

      it("the quarantine fallback reads no restricted document's raw chunks", async () => {
        const orch = orchestrator([], { knowledge: noHits });
        for (const agentKey of ["code", "document"] as const) {
          const chunks = (await orch.retrieveContext!({
            projectId: PROJECT,
            agentKey,
            documentIds: ["d-open", "d-secret"],
          } as never)) as Array<{ text: string }>;
          expect(
            chunks.map((c) => c.text),
            agentKey,
          ).toEqual([OPEN_TEXT]);
        }
        // With none selected, only the open upload is a default to fall back on.
        const none = (await orch.retrieveContext!({
          projectId: PROJECT,
          agentKey: "code",
        } as never)) as Array<{ text: string }>;
        expect(none.map((c) => c.text)).toEqual([OPEN_TEXT]);
      });

      it("the fallback reads the document once it is no longer restricted", async () => {
        await restrict([]);
        const chunks = (await orchestrator([], { knowledge: noHits }).retrieveContext!({
          projectId: PROJECT,
          agentKey: "document",
          documentIds: ["d-open", "d-secret"],
        } as never)) as Array<{ text: string }>;
        expect(chunks.map((c) => c.text).sort()).toEqual([OPEN_TEXT, SECRET_TEXT].sort());
      });
    });

    it("the requirement-grounded code agent never shows the model a restricted upload, and counts it", async () => {
      const seen: string[] = [];
      const id = "an-2431-rg";
      const { orch, capability } = await withTracker(id, seen);
      await orch.runRequirementGroundedCodeAgent!({
        analysisId: id,
        projectId: PROJECT,
        projectName: "Billing",
        projectDescription: "invoices",
        requirements: [{ id: "REQ-1", text: "Issue invoices monthly." }],
        documentIds: ["d-open", "d-secret"],
        signal: new AbortController().signal,
      } as never);
      const all = seen.join("\n");
      expect(all).toContain(OPEN_TEXT);
      expect(all).not.toContain(SECRET_TEXT);
      expect((await capability()).read.restrictedLeftOut).toMatchObject({ documentChunks: 1 });
    });

    it("the agentic code agent's search_knowledge reports what it dropped to the run", async () => {
      const denied: string[][] = [];
      const tools = assembleAgenticCodeTools({
        knowledgeService: knowledge as never,
        onDocumentAclDenied: (ids) => denied.push(ids),
      });
      const tool = tools.find((t) => t.name === "search_knowledge")!;
      const res = await tool.execute({ query: "invoices" }, { projectId: PROJECT });
      expect(res.content).toContain(OPEN_TEXT);
      expect(res.content).not.toContain(SECRET_TEXT);
      expect(denied).toEqual([["c-secret-0"]]);
    });

    it("a regenerate's document denials add to the stored record and keep its code counts", async () => {
      const id = "an-2431-regen";
      await db.analysis.upsert({
        where: { id },
        create: { id, projectId: PROJECT, status: "completed", startedById: ALICE },
        update: { metadata: null },
      });
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
      tracker.restrictedFiles = 2;
      tracker.restrictedSymbolIds = new Set(["s1"]);
      await persistAnalysisCapability(id, finalizeCapability(tracker));

      const orch = orchestrator();
      const pass = { checked: false, counts: {} };
      orch.regenRestrictedLeftOut.set(id, pass);
      // The regenerated document agent's retrieval: no code read, one chunk dropped.
      await orch.retrieveContext!({
        analysisId: id,
        projectId: PROJECT,
        agentKey: "document",
      } as never);
      expect(pass.checked).toBe(false);
      await (
        orch as unknown as {
          refreshRestrictedLeftOut: (a: string, p: unknown, merge: boolean) => Promise<void>;
        }
      ).refreshRestrictedLeftOut(id, pass, false);
      expect((await getAnalysisCapability(id))?.restrictedLeftOut).toEqual({
        reason: "shared-audience",
        files: 2,
        symbols: 1,
        documentChunks: 1,
      });
    });

    it("the affected-code seed names no restricted repository file, and counts it", async () => {
      const id = "an-2431-affected";
      await db.analysis.upsert({
        where: { id },
        create: { id, projectId: PROJECT, status: "completed", startedById: ALICE },
        update: { metadata: null },
      });
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
      const orch = orchestrator([], {
        affectedCode: {
          mapRequirement: async () => matches,
          dataSourceFor: () => new InMemoryCodeGraphDataSource([], []),
        },
      });
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
      const ctx = (await (
        orch as unknown as {
          computeAffectedCode: (a: string, p: string, x: string) => Promise<unknown>;
        }
      ).computeAffectedCode(id, PROJECT, "Add a monthly invoice charge.")) as {
        block: string;
        filePaths: string[];
      };
      expect(ctx.filePaths).toEqual(["src/billing/invoice.ts"]);
      expect(ctx.block).not.toContain("secret.ts");
      const row = await db.analysis.findUniqueOrThrow({ where: { id } });
      expect(row.metadata).toContain("InvoiceService.charge");
      expect(row.metadata).not.toContain("secret.ts");
      expect(row.metadata).not.toContain("SecretPricing");
      expect(finalizeCapability(tracker).restrictedLeftOut).toEqual({
        reason: "shared-audience",
        files: 1,
        symbols: 0,
      });
    });
  },
);
