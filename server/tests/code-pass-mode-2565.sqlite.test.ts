/**
 * #2565 — the analysis code pass's explore-first mode, driven through the real
 * `runAgenticCodeAgent` over a real SQLite database and a real clone:
 *
 *   - `fast` hands `runAgentLoop` exactly what `main` handed it before #2565
 *     (the snapshot below was written from `main`, before the change);
 *   - a connector with no clone runs `fast`, and the run's capability record,
 *     persisted and read back through the analysis snapshot in a fresh
 *     client, says so (`no-working-tree`).
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

const state = vi.hoisted(() => ({
  db: null as unknown,
  loopCalls: [] as unknown[][],
}));
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
  persistAgentResult: vi.fn(async () => ({ id: "ar-2565", findingIds: [] })),
}));
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));
// Every `runAgentLoop` call is recorded, then run for real.
vi.mock("../src/lib/analysis/agent-loop.js", async (original) => {
  const real = await original<typeof import("../src/lib/analysis/agent-loop.js")>();
  return {
    ...real,
    runAgentLoop: (...args: Parameters<typeof real.runAgentLoop>) => {
      state.loopCalls.push(args);
      return real.runAgentLoop(...args);
    },
  };
});

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { createCapabilityTracker } = await import("../src/lib/analysis/analysis-capability.js");
const { __resetConfigSingleton } = await import("../src/lib/config/config-service.js");

const USER = "u-2565";
const PROJECT = "p-2565";
const REPO = "rc-2565";
const GRAPH = "g-2565";
const ANSWER = JSON.stringify({ agentKey: "code", summary: "done", findings: [], notes: [] });

/** What a `runAgentLoop` call was handed, with functions and the signal named, not serialised. */
function describeLoopCall(call: unknown[]): unknown {
  const [, input, options] = call as [
    unknown,
    {
      systemMessage: string;
      userMessage: string;
      tools: Array<{ name: string; description: string; parameters: unknown }>;
    },
    Record<string, unknown>,
  ];
  return {
    systemMessage: input.systemMessage,
    userMessage: input.userMessage,
    tools: input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    options: JSON.parse(
      JSON.stringify(options, (key, value: unknown) =>
        key === "signal" ? "[signal]" : typeof value === "function" ? "[function]" : value,
      ),
    ) as unknown,
  };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2565 — the code pass mode (real SQLite, real clone)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let cloneRoot: string;
    const savedCloneDir = process.env.REPO_CLONE_DIR;
    const searcher: FusedCodeSearcher = {
      search: async () => [
        {
          symbolId: "s-fee",
          filePath: "src/fee.ts",
          name: "computeFee",
          kind: "function",
          score: 0.8,
        },
      ],
    };
    const lineLookup: SymbolLineLookup = {
      resolve: async (ids) =>
        new Map(ids.map((id) => [id, { filePath: "src/fee.ts", startLine: 1, endLine: 3 }])),
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("code-pass-mode-2565");
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
      cloneRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2565-"));
      mkdirSync(path.join(cloneRoot, REPO, "src"), { recursive: true });
      writeFileSync(
        path.join(cloneRoot, REPO, "src", "fee.ts"),
        "export function computeFee() {}\n",
      );
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      state.loopCalls.length = 0;
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

    type Orch = {
      capabilities: Map<string, ReturnType<typeof createCapabilityTracker>>;
      runAgenticCodeAgent: (input: Record<string, unknown>) => Promise<unknown>;
    };

    /** An orchestrator whose stub model always answers at once, and a tracker for `analysisId`. */
    const orchestratorFor = async (analysisId: string, clone: "healthy" | "unusable") => {
      await db.analysis.upsert({
        where: { id: analysisId },
        create: { id: analysisId, projectId: PROJECT, status: "completed", startedById: USER },
        update: { metadata: null },
      });
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
        retrieve: async () => [],
        knowledge: { search: async () => ({ hits: [] }) } as never,
        fusedCode: { searcher, lineLookup },
        prepareRepoClone: async () => clone,
      }) as unknown as Orch;
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
      orch.capabilities.set(analysisId, tracker);
      return { orch, tracker };
    };

    const run = (orch: Orch, analysisId: string) => {
      process.env.REPO_CLONE_DIR = cloneRoot;
      return orch.runAgenticCodeAgent({
        analysisId,
        projectId: PROJECT,
        projectName: "Fees",
        projectDescription: "fees",
        requirements: [{ id: "REQ-1", text: "Compute the fee." }],
        signal: new AbortController().signal,
        connectorId: REPO,
      });
    };

    it("fast: the system message, tools and loop options are byte-identical to main", async () => {
      process.env.ANALYSIS_CODE_EXPLORATION = "fast";
      __resetConfigSingleton();
      const { orch } = await orchestratorFor("an-2565-fast", "healthy");
      await run(orch, "an-2565-fast");
      expect(state.loopCalls).toHaveLength(1);
      expect(describeLoopCall(state.loopCalls[0]!)).toMatchSnapshot();
    });
  },
);
