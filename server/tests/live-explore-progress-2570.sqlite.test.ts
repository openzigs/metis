/**
 * #2570 — an exploring code pass reports what it is doing on the live
 * snapshot, counts only. Driven through the real `runAgenticCodeAgent` over a
 * real SQLite database and a real clone, with a stub model that pauses
 * mid-pass while the test reads the snapshot the analysis page polls:
 *
 *   - 2 `grep_files`, 3 `read_file_slice` (3 files) and 1 `search_code_graph`
 *     read back as `{ filesRead: 3, searches: 3, mode: "explore" }`;
 *   - the served entry names no file and no tool argument;
 *   - `fast` reports the same fields, with its own (lower) counts;
 *   - the entry is gone once the pass ends.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { FusedCodeSearcher, SymbolLineLookup } from "../src/lib/rag/fused-code-context.js";

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
  persistAgentResult: vi.fn(async () => ({ id: "ar-2570", findingIds: [] })),
}));
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { createCapabilityTracker } = await import("../src/lib/analysis/analysis-capability.js");
const { getAnalysisSnapshot } = await import("../src/lib/analysis/analysis-service.js");
const { readLiveAgents } = await import("../src/lib/analysis/live-agent-progress.js");
const { __resetConfigSingleton } = await import("../src/lib/config/config-service.js");

const USER = "u-2570";
const PROJECT = "p-2570";
const REPO = "rc-2570";
const GRAPH = "g-2570";
const ANSWER = JSON.stringify({ agentKey: "code", summary: "done", findings: [], notes: [] });
/** Every fixture path and search term carries it, so a leak is one `includes` away. */
const MARKER = "zzmark2570";
const FILES = ["a", "b", "c"].map((n) => `src/${MARKER}-${n}.ts`);
const call = (tool: string, args: Record<string, unknown>) => JSON.stringify({ tool, ...args });
const grep = (text: string) => call("grep_files", { text });
const read = (filePath: string) => call("read_file_slice", { filePath });
const graph = (query: string) => call("search_code_graph", { query });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2570 — live explore progress on the snapshot (real SQLite, real clone)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let cloneRoot: string;
    const savedCloneDir = process.env.REPO_CLONE_DIR;
    const searcher: FusedCodeSearcher = { search: async () => [] };
    const lineLookup: SymbolLineLookup = { resolve: async () => new Map() };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("live-explore-progress-2570");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: "ana", displayName: "ana", email: "ana@example.test" },
      });
      await db.project.create({
        data: { id: PROJECT, name: "Fees", slug: PROJECT, createdById: USER },
      });
      await db.repoConnection.create({
        data: { id: REPO, projectId: PROJECT, label: "app", isPrimary: true },
      });
      await db.codeGraph.create({
        data: {
          id: GRAPH,
          projectId: PROJECT,
          repoConnectionId: REPO,
          commitSha: "a".repeat(40),
          lastIndexedAt: new Date(),
        },
      });
      cloneRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2570-"));
      mkdirSync(path.join(cloneRoot, REPO, "src"), { recursive: true });
      for (const file of FILES) {
        writeFileSync(path.join(cloneRoot, REPO, file), `export const fee = "${MARKER}";\n`);
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      delete process.env.ANALYSIS_CODE_EXPLORATION;
      __resetConfigSingleton();
    });

    afterAll(async () => {
      if (savedCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
      else process.env.REPO_CLONE_DIR = savedCloneDir;
      await db?.$disconnect();
      sqlite?.cleanup();
      if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
    });

    /**
     * Run a code pass whose model replies `script[n]`, pausing at the first
     * call past the script; `whilePaused` reads the snapshot there.
     */
    const runPaused = async (
      mode: "explore" | "fast",
      analysisId: string,
      script: string[],
      whilePaused: () => Promise<void>,
    ) => {
      process.env.ANALYSIS_CODE_EXPLORATION = mode;
      __resetConfigSingleton();
      await db.analysis.upsert({
        where: { id: analysisId },
        create: { id: analysisId, projectId: PROJECT, status: "running", startedById: USER },
        update: {},
      });
      let calls = 0;
      let pausedCheck: Promise<void> | undefined;
      const orch = new AnalysisOrchestrator({
        provider: {
          key: "offline-stub",
          model: "stub",
          offline: true,
          chat: vi.fn(async () => {
            const n = calls++;
            if (n === script.length) {
              pausedCheck = whilePaused();
              await pausedCheck;
            }
            return {
              content: script[n] ?? ANSWER,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: "stub",
              provider: "offline-stub",
            };
          }),
        } as never,
        retrieve: async () => [],
        knowledge: { search: async () => ({ hits: [] }) } as never,
        fusedCode: { searcher, lineLookup },
        prepareRepoClone: async () => "healthy",
      }) as unknown as {
        capabilities: Map<string, ReturnType<typeof createCapabilityTracker>>;
        runAgenticCodeAgent: (input: Record<string, unknown>) => Promise<unknown>;
      };
      orch.capabilities.set(
        analysisId,
        createCapabilityTracker({
          static: {
            codeGraphPresent: true,
            repoSourceIngested: true,
            fusedCodeRetrievalEnabled: true,
            schemaContextEnabled: true,
          },
          codeAnalysisRequested: true,
          databaseAnalysisRequested: false,
        }),
      );
      process.env.REPO_CLONE_DIR = cloneRoot;
      await orch.runAgenticCodeAgent({
        analysisId,
        projectId: PROJECT,
        projectName: "Fees",
        projectDescription: "fees",
        requirements: [{ id: "REQ-1", text: "Compute the fee." }],
        signal: new AbortController().signal,
        connectorId: REPO,
      });
      expect(pausedCheck).toBeDefined();
      await pausedCheck;
    };

    it("explore: 2 greps, 3 reads and 1 graph search read back as { filesRead: 3, searches: 3 }, counts only", async () => {
      const analysisId = "an-2570-explore";
      let live: unknown;
      let served = "";
      await runPaused(
        "explore",
        analysisId,
        [
          grep(`${MARKER}-term`),
          read(FILES[0]!),
          grep("fee"),
          read(FILES[1]!),
          graph(`${MARKER} query`),
          read(FILES[2]!),
        ],
        async () => {
          const snap = await getAnalysisSnapshot(analysisId);
          live = snap?.liveAgents;
          served = JSON.stringify(snap?.liveAgents);
          expect(snap?.liveAgentsReadAt).toEqual(expect.any(String));
        },
      );
      expect(live).toEqual([
        expect.objectContaining({
          agentKey: "code",
          toolCalls: 6,
          filesRead: 3,
          searches: 3,
          mode: "explore",
          phase: "investigating",
        }),
      ]);
      // No file path, no search term, no query: the marker is in all of them.
      expect(served).not.toContain(MARKER);
      expect(served).not.toContain("src/");
      // The pass owned its entry: gone once it ended.
      expect(readLiveAgents(analysisId)).toEqual([]);
    });

    it("fast: the same fields, with fast's own counts", async () => {
      const analysisId = "an-2570-fast";
      let live: unknown;
      await runPaused(
        "fast",
        analysisId,
        [read(FILES[0]!), read(FILES[0]!), graph("fee")],
        async () => {
          live = (await getAnalysisSnapshot(analysisId))?.liveAgents;
        },
      );
      expect(live).toEqual([
        expect.objectContaining({ toolCalls: 3, filesRead: 1, searches: 1, mode: "fast" }),
      ]);
      expect(readLiveAgents(analysisId)).toEqual([]);
    });
  },
);
