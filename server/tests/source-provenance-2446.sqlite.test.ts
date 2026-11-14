/**
 * #2446 (epic #2438) — every analysis finding, citation and generated
 * requirement records, at write time, the ids of the sources it drew on, over
 * a real SQLite database built by the migration chain (and, for the analysis
 * paths, a real clone on disk). Read back through the database, never from the
 * object the write was handed.
 *
 *   - `persistAgentResult` resolves each citation to `Document` and
 *     `KnowledgeChunk` ids in the analysis's own project, per citation and per
 *     finding, and stores ids only;
 *   - a requirement (synthesis, elicited NFR, withheld re-synthesis applied)
 *     and a cross-document finding record the union of the findings they rest
 *     on, and none when one of those has no record;
 *   - a run started now is marked `sourceAccess = "shared"`; a run from before
 *     #2446 keeps NULL, the shared-audience rule, with nothing backfilled;
 *   - the five code paths (agentic, requirement-grounded, single-shot,
 *     regenerate, resume) all write it.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { AgentOutput, Citation, SynthesisOutput } from "@metis/shared";
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
  persistAgentResult,
  persistAnalysisCapability,
  persistCrossDocFindings,
  persistRequirements,
} = await import("../src/lib/analysis/analysis-service.js");
const { applyWithheldReplacement, getWithheldReplacementDiff } =
  await import("../src/lib/analysis/withheld-replacement-service.js");
const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");

const ALICE = "u-2446";
/** Section 1: citations resolved, requirements and cross-document findings. */
const PROJECT = "p-2446";
const OTHER_PROJECT = "p-2446-other";
const R1 = "rc-2446-1";
const R2 = "rc-2446-2";
/** Section 2: the analysis paths, over one repository and a real clone. */
const RUN_PROJECT = "p-2446-run";
const RUN_REPO = "rc-2446-run";
const RUN_GRAPH = "g-2446-run";

interface StoredSources {
  documentIds: string[];
  chunkIds: string[];
  citations?: Array<{ documentIds: string[]; chunkIds: string[] }>;
}

const NOTHING = { documentIds: [], chunkIds: [] };

function output(findings: Array<{ title: string; citations: unknown[] }>): AgentOutput {
  return {
    agentKey: "code",
    summary: "s",
    notes: [],
    findings: findings.map((f) => ({
      category: "architecture",
      severity: "info",
      title: f.title,
      body: `${f.title} body`,
      tags: [],
      citations: f.citations as Citation[],
    })),
  } as AgentOutput;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2446 — analysis rows record the sources they drew on (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let cloneRoot: string;
    const savedCloneDir = process.env.REPO_CLONE_DIR;

    const doc = (id: string, projectId: string, filename: string, source = "repo") =>
      db.document.create({
        data: {
          id,
          projectId,
          filename,
          source,
          mimeType: "text/markdown",
          sizeBytes: 1,
          storagePath: `/tmp/${id}`,
          checksum: id,
          uploadedById: ALICE,
          status: "ready",
        },
      });
    const chunk = (id: string, projectId: string, documentId: string, position: number) =>
      db.knowledgeChunk.create({
        data: { id, projectId, documentId, position, text: `chunk ${id}`, md5: id },
      });
    const analysis = (id: string, projectId: string) =>
      db.analysis.create({
        data: { id, projectId, status: "completed", startedById: ALICE },
      });
    /** The stored `sourceIds` of every finding of `analysisId`, by title. */
    const findingSources = async (analysisId: string) => {
      const rows = await db.finding.findMany({
        where: { agentResult: { analysisId } },
        select: { title: true, sourceIds: true },
      });
      return Object.fromEntries(
        rows.map((r) => [r.title, r.sourceIds === null ? null : JSON.parse(r.sourceIds)]),
      ) as Record<string, StoredSources | null>;
    };
    const requirementSources = async (analysisId: string) => {
      const rows = await db.requirement.findMany({
        where: { analysisId },
        select: { title: true, sourceIds: true },
      });
      return Object.fromEntries(
        rows.map((r) => [r.title, r.sourceIds === null ? null : JSON.parse(r.sourceIds)]),
      ) as Record<string, StoredSources | null>;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("source-provenance-2446");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: ALICE, username: "alice", displayName: "alice", email: "a@example.test" },
      });
      for (const id of [PROJECT, OTHER_PROJECT, RUN_PROJECT]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: ALICE } });
      }
      for (const [id, projectId, primary] of [
        [R1, PROJECT, true],
        [R2, PROJECT, false],
        [RUN_REPO, RUN_PROJECT, true],
      ] as const) {
        await db.repoConnection.create({
          data: { id, projectId, label: id, isPrimary: primary },
        });
      }
      // Section 1: the same path in two repositories, a root manifest, an
      // uploaded document with two chunks, and another project's document.
      await doc("d-a-r1", PROJECT, `connector:repo:${R1}:src/src/a.ts`);
      await doc("d-a-r2", PROJECT, `connector:repo:${R2}:src/src/a.ts`);
      await doc("d-manifest", PROJECT, `connector:repo:${R1}:package.json`);
      await doc("d-spec", PROJECT, "spec.md", "upload");
      await chunk("k-spec-0", PROJECT, "d-spec", 0);
      await chunk("k-spec-1", PROJECT, "d-spec", 1);
      await doc("d-other", OTHER_PROJECT, "other.md", "upload");
      await chunk("k-other-0", OTHER_PROJECT, "d-other", 0);

      // Section 2: the run fixture, as in #2314's.
      await db.codeGraph.create({
        data: {
          id: RUN_GRAPH,
          projectId: RUN_PROJECT,
          repoConnectionId: RUN_REPO,
          commitSha: "a".repeat(40),
          lastIndexedAt: new Date(),
        },
      });
      await db.codeSymbol.create({
        data: {
          id: "s-fee",
          codeGraphId: RUN_GRAPH,
          projectId: RUN_PROJECT,
          kind: "function",
          name: "computeFee",
          qualifiedName: "src/fee.ts::computeFee",
          filePath: "src/fee.ts",
          startLine: 1,
          endLine: 3,
          language: "ts",
          contentHash: "s-fee",
        },
      });
      await doc("d-fee", RUN_PROJECT, `connector:repo:${RUN_REPO}:src/src/fee.ts`);
      await doc("d-brief", RUN_PROJECT, "brief.md", "upload");
      await chunk("k-brief-0", RUN_PROJECT, "d-brief", 0);
      cloneRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2446-"));
      mkdirSync(path.join(cloneRoot, RUN_REPO, "src"), { recursive: true });
      writeFileSync(
        path.join(cloneRoot, RUN_REPO, "src", "fee.ts"),
        "export function computeFee() {\n  return 1;\n}\n",
      );
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
      if (savedCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
      else process.env.REPO_CLONE_DIR = savedCloneDir;
    });

    describe("a run's marker", () => {
      it("a run started now reads `shared`; a run from before #2446 keeps NULL", async () => {
        const started = await createAnalysis({
          projectId: PROJECT,
          startedById: ALICE,
          agentKeys: ["code"],
          title: "Checkout",
        });
        expect(
          (await db.analysis.findUniqueOrThrow({ where: { id: started.id } })).sourceAccess,
        ).toBe("shared");
        // A row written without the marker (as every row before the migration
        // was) is not backfilled: it reads NULL, the shared-audience rule.
        const legacy = await analysis("an-2446-legacy", PROJECT);
        expect(legacy.sourceAccess).toBeNull();
      });
    });

    describe("a finding and its citations", () => {
      const ANALYSIS = "an-2446-cite";
      let stored: Record<string, StoredSources | null>;
      let raw: string;

      beforeAll(async () => {
        await analysis(ANALYSIS, PROJECT);
        await persistAgentResult({
          analysisId: ANALYSIS,
          agentKey: "code",
          status: "completed",
          startedAt: new Date(),
          completedAt: new Date(),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          output: output([
            {
              title: "cites everything",
              citations: [
                { documentId: "d-spec", chunkIndex: 1, filename: "spec.md", snippet: "SPEC TEXT" },
                {
                  filePath: "./src/a.ts",
                  startLine: 1,
                  endLine: 2,
                  repoConnectionId: R1,
                  snippet: "A SNIPPET",
                },
                { filePath: "src/a.ts", startLine: 1, endLine: 2 },
                { filePath: "package.json", startLine: 1, endLine: 1, repoConnectionId: R1 },
                { documentId: "code-graph:s-unresolved", chunkIndex: 0 },
                { documentId: "d-other", chunkIndex: 0 },
                { documentId: "d-missing", chunkIndex: 0 },
                { documentId: "d-spec", chunkIndex: 7 },
              ],
            },
            { title: "cites nothing", citations: [] },
          ]),
        });
        stored = await findingSources(ANALYSIS);
        raw = (
          await db.finding.findMany({
            where: { agentResult: { analysisId: ANALYSIS } },
            select: { sourceIds: true },
          })
        )
          .map((r) => r.sourceIds)
          .join("\n");
      });

      it("records the documents and chunks each citation names, in citation order", () => {
        expect(stored["cites everything"]).toEqual({
          documentIds: ["d-a-r1", "d-a-r2", "d-manifest", "d-spec"],
          chunkIds: ["k-spec-1"],
          citations: [
            // A document citation: its document and the chunk at its index.
            { documentIds: ["d-spec"], chunkIds: ["k-spec-1"] },
            // A code citation grounded in a repository: that repository's file.
            { documentIds: ["d-a-r1"], chunkIds: [] },
            // No repository (#1611): the path's file in every repository.
            { documentIds: ["d-a-r1", "d-a-r2"], chunkIds: [] },
            // A root manifest is ingested without the `src/` prefix.
            { documentIds: ["d-manifest"], chunkIds: [] },
            // A synthetic code-graph id, another project's document and an id
            // that names no row are not sources of anything.
            NOTHING,
            NOTHING,
            NOTHING,
            // A real document at a chunk index it does not have: the document only.
            { documentIds: ["d-spec"], chunkIds: [] },
          ],
        });
      });

      it("still writes the findings when their sources cannot be read, recording none", async () => {
        const id = "an-2446-unreadable";
        await analysis(id, PROJECT);
        const spy = vi
          .spyOn(db.document, "findMany")
          .mockRejectedValueOnce(new Error("database unavailable"));
        try {
          await persistAgentResult({
            analysisId: id,
            agentKey: "code",
            status: "completed",
            startedAt: new Date(),
            completedAt: new Date(),
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            output: output([
              { title: "kept", citations: [{ documentId: "d-spec", chunkIndex: 0 }] },
            ]),
          });
        } finally {
          spy.mockRestore();
        }
        // NULL is "not recorded", which a reader treats fail-closed (#2447).
        expect(await findingSources(id)).toEqual({ kept: null });
      });

      it("records an empty set for a finding that cites nothing", () => {
        expect(stored["cites nothing"]).toEqual({ ...NOTHING, citations: [] });
      });

      it("stores ids only: no path, filename or snippet", () => {
        for (const named of [
          "a.ts",
          "package.json",
          "spec.md",
          "SNIPPET",
          "SPEC TEXT",
          "d-other",
        ]) {
          expect(raw).not.toContain(named);
        }
      });
    });

    describe("requirements and cross-document findings", () => {
      const ANALYSIS = "an-2446-req";
      /** Index-aligned with what synthesis saw: f-a, f-b, then a pre-#2446 finding. */
      let findingIdsByIndex: string[];

      const requirement = (title: string, evidenceFindingIndexes: number[]) => ({
        type: "feature" as const,
        title,
        body: `${title} body`,
        priority: "medium" as const,
        labels: [],
        evidenceFindingIndexes,
        acceptanceCriteria: [],
      });

      beforeAll(async () => {
        await analysis(ANALYSIS, PROJECT);
        const persisted = await persistAgentResult({
          analysisId: ANALYSIS,
          agentKey: "code",
          status: "completed",
          startedAt: new Date(),
          completedAt: new Date(),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          output: output([
            { title: "f-a", citations: [{ documentId: "d-spec", chunkIndex: 0 }] },
            {
              title: "f-b",
              citations: [{ filePath: "src/a.ts", startLine: 1, endLine: 1, repoConnectionId: R2 }],
            },
          ]),
        });
        // A finding written before #2446: no record.
        const legacy = await db.finding.create({
          data: {
            agentResultId: persisted.id,
            category: "architecture",
            title: "f-legacy",
            body: "b",
          },
        });
        findingIdsByIndex = [...persisted.findingIds, legacy.id];
      });

      it("a requirement records the union of its evidence findings', and none when one has no record", async () => {
        const synthesis: SynthesisOutput = {
          summary: "s",
          requirements: [
            requirement("both", [0, 1]),
            requirement("one", [1]),
            requirement("no evidence", []),
            requirement("rests on a legacy finding", [0, 2]),
          ],
        } as SynthesisOutput;
        await persistRequirements({
          analysisId: ANALYSIS,
          projectId: PROJECT,
          synthesis,
          findingIdsByIndex,
          elicited: {
            requirements: [requirement("elicited NFR", [0])],
            coverages: ["no_evidence"],
            verdicts: [null],
          },
        });
        expect(await requirementSources(ANALYSIS)).toEqual({
          both: { documentIds: ["d-a-r2", "d-spec"], chunkIds: ["k-spec-0"] },
          one: { documentIds: ["d-a-r2"], chunkIds: [] },
          "no evidence": NOTHING,
          "rests on a legacy finding": null,
          "elicited NFR": { documentIds: ["d-spec"], chunkIds: ["k-spec-0"] },
        });
      });

      it("a cross-document finding records the union of its evidence findings', from its own analysis only", async () => {
        // A finding of another analysis of the same project is not this one's evidence.
        await analysis("an-2446-req-other", PROJECT);
        const elsewhere = await persistAgentResult({
          analysisId: "an-2446-req-other",
          agentKey: "code",
          status: "completed",
          startedAt: new Date(),
          completedAt: new Date(),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          output: output([{ title: "x", citations: [] }]),
        });
        const [fa, fb, legacy] = findingIdsByIndex;
        const kinds = ["contradiction", "missing-nfr", "missing-risk", "missing-assumption"];
        const ids = await persistCrossDocFindings({
          analysisId: ANALYSIS,
          findings: [[fa, fb], [], [fa, legacy], [fa, elsewhere.findingIds[0]]].map(
            (evidenceIds, i) => ({
              kind: kinds[i],
              severity: "medium",
              title: `cdf-${i}`,
              detail: "d",
              evidenceIds,
            }),
          ) as never,
        });
        const rows = await db.crossDocFinding.findMany({
          where: { id: { in: ids } },
          select: { title: true, sourceIds: true },
        });
        const byTitle = Object.fromEntries(
          rows.map((r) => [r.title, r.sourceIds === null ? null : JSON.parse(r.sourceIds)]),
        );
        expect(byTitle).toEqual({
          "cdf-0": { documentIds: ["d-a-r2", "d-spec"], chunkIds: ["k-spec-0"] },
          "cdf-1": NOTHING,
          "cdf-2": null,
          "cdf-3": null,
        });
      });

      it("applying a withheld re-synthesis records the sources of the rows it writes", async () => {
        const WITHHELD = "an-2446-withheld";
        await analysis(WITHHELD, PROJECT);
        const persisted = await persistAgentResult({
          analysisId: WITHHELD,
          agentKey: "code",
          status: "completed",
          startedAt: new Date(),
          completedAt: new Date(),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          output: output([
            { title: "w-a", citations: [{ documentId: "d-spec", chunkIndex: 0 }] },
            { title: "w-b", citations: [{ documentId: "d-spec", chunkIndex: 1 }] },
          ]),
        });
        const set = (items: Array<[string, string, number[]]>): SynthesisOutput =>
          ({
            summary: "s",
            requirements: items.map(([title, body, evidence]) => ({
              ...requirement(title, evidence),
              body,
            })),
          }) as SynthesisOutput;
        await persistRequirements({
          analysisId: WITHHELD,
          projectId: PROJECT,
          synthesis: set([["Reviewed", "first text", [0]]]),
          findingIdsByIndex: persisted.findingIds,
        });
        // Review work: the re-synthesis below is withheld (#769), not written.
        await db.requirement.updateMany({
          where: { analysisId: WITHHELD },
          data: { reviewStatus: "approved" },
        });
        await persistRequirements({
          analysisId: WITHHELD,
          projectId: PROJECT,
          synthesis: set([
            ["Reviewed", "second text", [1]],
            ["Added", "new", [1]],
          ]),
          findingIdsByIndex: persisted.findingIds,
        });
        expect(Object.keys(await requirementSources(WITHHELD))).toEqual(["Reviewed"]);

        const diff = await getWithheldReplacementDiff(WITHHELD);
        await applyWithheldReplacement({
          analysisId: WITHHELD,
          projectId: PROJECT,
          actorId: ALICE,
          at: diff!.withheld.at,
          fingerprint: diff!.fingerprint,
        });
        expect(await requirementSources(WITHHELD)).toEqual({
          // Its own evidence and the proposal's text: both.
          Reviewed: { documentIds: ["d-spec"], chunkIds: ["k-spec-0", "k-spec-1"] },
          Added: { documentIds: ["d-spec"], chunkIds: ["k-spec-1"] },
        });
      });
    });

    // The five code paths. Each is the real orchestrator method over a real
    // clone and fused seed, with a model that answers one finding citing the
    // repository file and an uploaded document chunk, and the real
    // `persistAgentResult` writing it.
    describe("every analysis path records them", () => {
      const ANSWER = JSON.stringify({
        agentKey: "code",
        summary: "done",
        notes: [],
        findings: [
          {
            category: "architecture",
            severity: "info",
            title: "Fee is computed in one place",
            body: "computeFee returns the fee.",
            requirementId: "REQ-1",
            // Grounded in the fused seed's symbol, so every path keeps it and
            // stamps its repository (#1611). Document citations are resolved
            // in "a finding and its citations" above.
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
        ],
      };
      const lineLookup: SymbolLineLookup = {
        resolve: async (ids) =>
          new Map(ids.map((id) => [id, { filePath: "src/fee.ts", startLine: 1, endLine: 3 }])),
      };
      type Orch = Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
      const orchestrator = () => {
        const orch = new AnalysisOrchestrator({
          provider: {
            key: "offline-stub",
            model: "stub",
            offline: true,
            chat: vi.fn(async () => ({
              content: ANSWER,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: "stub",
              provider: "offline-stub",
            })),
          } as never,
          knowledge: { search: async () => ({ hits: [] }) } as never,
          fusedCode: { searcher, lineLookup },
          prepareRepoClone: async () => "healthy",
        }) as unknown as Orch;
        // Regenerate and resume re-synthesise afterwards; not under test here.
        orch.runSynthesisAndPersist = vi.fn(async () => undefined);
        return orch;
      };
      const common = (analysisId: string) => ({
        analysisId,
        projectId: RUN_PROJECT,
        projectName: "Fees",
        projectDescription: "fees",
        signal: new AbortController().signal,
      });
      const REQUIREMENTS = [{ id: "REQ-1", text: "Compute the fee." }];
      const EXPECTED: StoredSources = {
        documentIds: ["d-fee"],
        chunkIds: [],
        citations: [{ documentIds: ["d-fee"], chunkIds: [] }],
      };
      const runs: Record<string, (orch: Orch, analysisId: string) => Promise<unknown>> = {
        agentic: (orch, id) =>
          orch.runAgenticCodeAgent!({
            ...common(id),
            requirements: REQUIREMENTS,
            connectorId: RUN_REPO,
            actorId: ALICE,
          }),
        "requirement-grounded": (orch, id) =>
          orch.runRequirementGroundedCodeAgent!({
            ...common(id),
            requirements: REQUIREMENTS,
            documentIds: ["d-brief"],
          }),
        "single-shot": (orch, id) =>
          orch.runOneAgent!({ ...common(id), agentKey: "code", documentIds: ["d-brief"] }),
        regenerate: (orch, id) =>
          orch.regenerateAgent!({ analysisId: id, agentKey: "code", actorId: ALICE }),
        resume: async (orch, id) => {
          await persistAnalysisCapability(id, {
            codeAnalysisRequested: true,
            databaseAnalysisRequested: false,
            codeGraphPresent: true,
            agentMode: "agentic",
            repoSourceIngested: true,
            fusedCodeRetrievalEnabled: true,
            schemaContextEnabled: true,
            quarantineFallbackUsed: false,
            skippedRepos: [{ connectorId: RUN_REPO, label: RUN_REPO, reason: "budget" }],
            reasons: ["repos-skipped-budget"],
          } as never);
          return orch.resumeSkippedRepos!({ analysisId: id, actorId: ALICE });
        },
      };

      for (const [name, run] of Object.entries(runs)) {
        it(`the ${name} path`, async () => {
          process.env.REPO_CLONE_DIR = cloneRoot;
          const id = `an-2446-${name}`;
          await db.analysis.create({
            data: {
              id,
              projectId: RUN_PROJECT,
              status: "completed",
              startedById: ALICE,
              sourceAccess: "shared",
              metadata: JSON.stringify({
                agentKeys: ["code"],
                documentIds: ["d-brief"],
                extraInstructions: "REQ-1: Compute the fee.",
              }),
            },
          });
          await run(orchestrator(), id);
          const stored = await findingSources(id);
          expect(Object.keys(stored)).toEqual(["Fee is computed in one place"]);
          expect(stored["Fee is computed in one place"]).toEqual(EXPECTED);
          const raw = (
            await db.finding.findFirstOrThrow({
              where: { agentResult: { analysisId: id } },
              select: { sourceIds: true },
            })
          ).sourceIds!;
          for (const named of ["fee.ts", "brief.md", "computeFee"]) {
            expect(raw).not.toContain(named);
          }
        });
      }
    });
  },
);
