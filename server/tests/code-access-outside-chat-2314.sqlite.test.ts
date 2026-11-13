/**
 * #2314 — document access for code reads outside chat's three code tools
 * (#2243 covered those), over a real SQLite database built by the migration
 * chain and a real clone on disk.
 *
 * `src/secret.ts` is ingested as a document restricted to its owner, Alice:
 *   - the analysis code agent's `read_file_slice` and `list_files` (the bare
 *     tools, with the `codeAccess` the orchestrator now sets) read as a shared
 *     audience: an analysis's findings are read by the whole project, so even
 *     Alice's own run neither reads nor lists her file, and the refusal reads
 *     like a missing file;
 *   - a real analysis run Alice started (`runAgenticCodeAgent`, its tool loop
 *     and its fused seed) never shows the file to the model;
 *   - fused symbol retrieval (`buildFusedCodeBlock`, the analysis seed through
 *     `retrieveFusedCodeChunks`, and Spec Kit's default) leaves its symbol out;
 *   - the chat tool-result cache follows a role change at once: a result read
 *     under one role never answers the same call under another.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import type { ToolContext } from "../src/lib/analysis/tools/types.js";
import type { FusedCodeSearcher, SymbolLineLookup } from "../src/lib/rag/fused-code-context.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
// #2314 — the run test inspects the model's conversation, not the persisted
// row: no Analysis row is created for it.
vi.mock("../src/lib/analysis/analysis-service.js", async (original) => ({
  ...(await original<typeof import("../src/lib/analysis/analysis-service.js")>()),
  persistAgentResult: vi.fn(async () => ({ id: "ar-2314", findingIds: [] })),
}));
// The content version must not probe an embedding sidecar.
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));

const { hiddenSymbolsFor, loadCodeAccessFilter, loadSharedCodeAccess, UNRESTRICTED_CODE_ACCESS } =
  await import("../src/lib/analysis/tools/code-access.js");
const { readFileSliceTool, FILE_NOT_FOUND } =
  await import("../src/lib/analysis/tools/read-file-slice.js");
const { listFilesTool } = await import("../src/lib/analysis/tools/list-files.js");
const { buildFusedCodeBlock } = await import("../src/lib/rag/fused-code-context.js");
const { retrieveFusedCodeChunks } = await import("../src/lib/analysis/fused-code-chunks.js");
const { buildSpecKitRagContext } = await import("../src/lib/spec-kit/rag-context.js");
const { codeRuntimeTool } = await import("../src/lib/ai/tool-runtime/toolset.js");
const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { createSearchSymbolsTool } = await import("../src/lib/analysis/tools/search-symbols.js");
const { __resetToolResultCacheForTests } =
  await import("../src/lib/ai/tool-runtime/tool-result-cache.js");

const ALICE = "u-alice";
const BOB = "u-bob";
const CAROL = "u-carol";
const GONE = "u-gone";
const PROJECT = "p-2314";
const REPO = "rc-2314";
const GRAPH = "g-2314";
const SECRET_DOC = "d-secret";
const SECRET_LINE = "export const SECRET_RATE = 0.42;";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2314 — document access for code reads outside chat (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    /** `REPO_CLONE_DIR` for the run test: the clone is `<root>/<REPO>`, where a run looks. */
    let cloneRoot: string;
    let clone: string;
    const savedCloneDir = process.env.REPO_CLONE_DIR;
    const searcher: FusedCodeSearcher = {
      search: async () => [
        {
          symbolId: "s-secret",
          filePath: "src/secret.ts",
          name: "computeSecretFee",
          kind: "function",
          score: 0.9,
          snippet: SECRET_LINE,
        },
        {
          symbolId: "s-public",
          filePath: "src/public.ts",
          name: "computeFee",
          kind: "function",
          score: 0.8,
        },
      ],
    };
    const lineLookup: SymbolLineLookup = {
      resolve: async (ids) =>
        new Map(
          ids.map((id) => [
            id,
            {
              filePath: id === "s-secret" ? "src/secret.ts" : "src/public.ts",
              startLine: 1,
              endLine: 3,
            },
          ]),
        ),
    };

    const restrict = (subjects: Array<{ kind: string; value: string }>) =>
      db.document.update({
        where: { id: SECRET_DOC },
        data: { aclSubjects: JSON.stringify(subjects) },
      });
    const setRole = async (userId: string, key: string) => {
      await db.userRole.deleteMany({ where: { userId } });
      await db.userRole.create({ data: { userId, roleId: `role-${key}`, source: "local" } });
    };
    /** The analysis code agent's tool context, as `runAgenticCodeAgent` builds it. */
    const analysisCtx = async (connectorId: string | undefined = REPO) =>
      ({
        projectId: PROJECT,
        ...(connectorId ? { connectorId } : {}),
        cloneDir: clone,
        codeAccess: await loadSharedCodeAccess(PROJECT),
      }) satisfies ToolContext;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("code-access-outside-chat-2314");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const [id, name] of [
        [ALICE, "alice"],
        [BOB, "bob"],
        [CAROL, "carol"],
        [GONE, "gone"],
      ] as const) {
        await db.user.create({
          data: {
            id,
            username: name,
            displayName: name,
            email: `${name}@example.test`,
            ...(id === GONE ? { status: "disabled" } : {}),
          },
        });
      }
      for (const key of ["developer", "reader"]) {
        await db.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      await setRole(CAROL, "reader");
      await db.project.create({
        data: { id: PROJECT, name: "Code", slug: PROJECT, createdById: ALICE },
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
      for (const [id, name, filePath] of [
        ["s-secret", "computeSecretFee", "src/secret.ts"],
        ["s-public", "computeFee", "src/public.ts"],
      ] as const) {
        await db.codeSymbol.create({
          data: {
            id,
            codeGraphId: GRAPH,
            projectId: PROJECT,
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
      const doc = (id: string, file: string, aclSubjects = "[]") =>
        db.document.create({
          data: {
            id,
            projectId: PROJECT,
            filename: `connector:repo:${REPO}:src/${file}`,
            source: "repo",
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: `/tmp/${id}`,
            checksum: id,
            uploadedById: ALICE,
            status: "ready",
            aclSubjects,
          },
        });
      await doc(SECRET_DOC, "src/secret.ts", JSON.stringify([{ kind: "user", value: ALICE }]));
      await doc("d-public", "src/public.ts");

      cloneRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2314-"));
      clone = path.join(cloneRoot, REPO);
      mkdirSync(path.join(clone, "src"), { recursive: true });
      writeFileSync(
        path.join(clone, "src", "secret.ts"),
        `${SECRET_LINE}\nexport function computeSecretFee() {}\n`,
      );
      writeFileSync(path.join(clone, "src", "public.ts"), "export function computeFee() {}\n");
      symlinkSync("secret.ts", path.join(clone, "src", "alias.ts"));
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      delete process.env.CHAT_TOOL_RESULT_CACHE_ENABLED;
      __resetToolResultCacheForTests();
      await restrict([{ kind: "user", value: ALICE }]);
      await setRole(CAROL, "reader");
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
      if (savedCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
      else process.env.REPO_CLONE_DIR = savedCloneDir;
    });

    describe("the analysis code agent's read_file_slice", () => {
      it("refuses a restricted file, under any spelling or through a symlink, as if it were missing", async () => {
        const ctx = await analysisCtx();
        const missing = await readFileSliceTool.execute({ filePath: "src/nope.ts" }, ctx);
        expect(missing).toEqual({ content: `${FILE_NOT_FOUND} src/nope.ts`, isError: true });
        for (const filePath of [
          "src/secret.ts",
          "./src/secret.ts",
          "src/../src/secret.ts",
          "src/alias.ts",
        ]) {
          const r = await readFileSliceTool.execute({ filePath }, ctx);
          expect(r, filePath).toEqual({ content: `${FILE_NOT_FOUND} ${filePath}`, isError: true });
        }
        const open = await readFileSliceTool.execute({ filePath: "src/public.ts" }, ctx);
        expect(open.isError).toBeUndefined();
        expect(open.content).toContain("computeFee");
      });

      it("reads it for a context with no access filter (an eval harness)", async () => {
        const bare = await readFileSliceTool.execute(
          { filePath: "src/secret.ts" },
          { projectId: PROJECT, connectorId: REPO, cloneDir: clone },
        );
        expect(bare.content).toContain(SECRET_LINE);
      });

      it("matches a clone of unknown repository against every repository's restrictions", async () => {
        const r = await readFileSliceTool.execute(
          { filePath: "src/secret.ts" },
          await analysisCtx(undefined),
        );
        expect(r).toEqual({ content: `${FILE_NOT_FOUND} src/secret.ts`, isError: true });
      });

      it("reads the whole repository once the restriction is lifted", async () => {
        await restrict([]);
        const ctx = await analysisCtx();
        expect(ctx.codeAccess).toBe(UNRESTRICTED_CODE_ACCESS);
        const r = await readFileSliceTool.execute({ filePath: "src/secret.ts" }, ctx);
        expect(r.content).toContain(SECRET_LINE);
      });
    });

    describe("the analysis code agent's list_files", () => {
      it("neither lists nor counts a restricted file, and lists it once the restriction is lifted", async () => {
        const shared = await listFilesTool.execute({ pattern: "src/*.ts" }, await analysisCtx());
        expect(shared.content).toContain("src/public.ts");
        expect(shared.content).not.toContain("secret");
        expect(shared.resultCount).toBe(1);
        await restrict([]);
        const open = await listFilesTool.execute({ pattern: "src/*.ts" }, await analysisCtx());
        expect(open.content).toContain("src/secret.ts");
        expect(open.resultCount).toBe(2);
      });
    });

    // #2314 review — the filter must reach the tools INSIDE a run, not only a
    // hand-built ToolContext: the real `runAgenticCodeAgent`, its real tool
    // loop over the real clone, and its real fused seed. The run is started by
    // Alice, who may read `src/secret.ts` herself: an analysis's findings are
    // read by the whole project, so her run must still never show it.
    describe("a real analysis run Alice started", () => {
      it("never hands the model the restricted file: not by read_file_slice, list_files or the fused seed", async () => {
        process.env.REPO_CLONE_DIR = cloneRoot;
        const calls = [
          { tool: "read_file_slice", args: { filePath: "src/secret.ts" } },
          { tool: "read_file_slice", args: { filePath: "src/alias.ts" } },
          { tool: "read_file_slice", args: { filePath: "src/public.ts" } },
          { tool: "list_files", args: { pattern: "src/*.ts" } },
        ];
        const ANSWER = JSON.stringify({
          agentKey: "code",
          summary: "done",
          findings: [],
          notes: [],
        });
        const seen: string[] = [];
        let turn = 0;
        const provider = {
          key: "offline-stub",
          model: "stub",
          offline: true,
          chat: vi.fn(
            async (messages: Array<{ content: unknown }>, opts?: { systemMessage?: string }) => {
              if (typeof opts?.systemMessage === "string") seen.push(opts.systemMessage);
              for (const m of messages) if (typeof m.content === "string") seen.push(m.content);
              const next = calls[turn];
              turn += 1;
              return {
                content: next ? JSON.stringify(next) : ANSWER,
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                model: "stub",
                provider: "offline-stub",
              };
            },
          ),
        };
        const orch = new AnalysisOrchestrator({
          provider: provider as never,
          retrieve: async () => [],
          knowledge: { search: async () => ({ hits: [] }) } as never,
          fusedCode: { searcher, lineLookup },
          prepareRepoClone: async () => "healthy",
        });
        await (
          orch as unknown as {
            runAgenticCodeAgent: (input: Record<string, unknown>) => Promise<unknown>;
          }
        ).runAgenticCodeAgent({
          analysisId: "an-2314",
          projectId: PROJECT,
          projectName: "Code",
          projectDescription: "fees",
          requirements: [{ id: "REQ-1", text: "Compute the fee." }],
          signal: new AbortController().signal,
          connectorId: REPO,
          // The requester, as the pipeline passed it before this fix: it must
          // not widen what the run reads.
          actorId: ALICE,
        });

        expect(turn).toBeGreaterThan(calls.length); // every scripted call ran
        const all = seen.join("\n");
        const results = seen.filter((t) => t.includes("Tool result for")).join("\n");
        // Positive controls: the tools really ran on the clone, and the seed was built.
        expect(results).toContain("export function computeFee");
        expect(results).toContain("src/public.ts");
        expect(all).toContain("computeFee");
        // The restricted file reads like a missing one, under its name and its alias.
        expect(results).toContain(`${FILE_NOT_FOUND} src/secret.ts`);
        expect(results).toContain(`${FILE_NOT_FOUND} src/alias.ts`);
        expect(results).not.toMatch(/^src\/secret\.ts$/m);
        // Nothing of its content, nor its symbol, reached the model anywhere.
        expect(all).not.toContain(SECRET_LINE);
        expect(all).not.toContain("computeSecretFee");
      });
    });

    // #2314 panel — the other two analysis paths that seed fused symbols: the
    // requirement-grounded code agent and the single-shot code agent's context.
    describe("the requirement-grounded and single-shot analysis paths", () => {
      const ANSWER = JSON.stringify({ agentKey: "code", summary: "done", findings: [], notes: [] });
      const orchestrator = (seen: string[]) =>
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
          knowledge: { search: async () => ({ hits: [] }) } as never,
          fusedCode: { searcher, lineLookup },
        }) as unknown as Record<string, (input: Record<string, unknown>) => Promise<unknown>>;

      it("the requirement-grounded code agent never shows the model a restricted symbol", async () => {
        const seen: string[] = [];
        await orchestrator(seen).runRequirementGroundedCodeAgent!({
          analysisId: "an-2314-rg",
          projectId: PROJECT,
          projectName: "Code",
          projectDescription: "fees",
          requirements: [{ id: "REQ-1", text: "Compute the fee." }],
          documentIds: ["d-none"],
          signal: new AbortController().signal,
        });
        const all = seen.join("\n");
        expect(all).toContain("computeFee"); // the seed was built and reached the model
        expect(all).not.toContain("computeSecretFee");
        expect(all).not.toContain(SECRET_LINE);
      });

      it("the single-shot code agent's context leaves the restricted symbol out", async () => {
        const chunks = (await orchestrator([]).retrieveContext!({
          analysisId: "an-2314-ss",
          projectId: PROJECT,
          agentKey: "code",
          documentIds: ["d-none"],
          projectName: "Code",
          projectDescription: "fees",
        })) as Array<{ symbolId?: string }>;
        const symbols = chunks.map((c) => c.symbolId).filter(Boolean);
        expect(symbols).toEqual(["s-public"]);
      });
    });

    describe("fused symbol retrieval", () => {
      /** A reader's block: a user's own access (chat), or the shared audience's. */
      const block = (userId: string | "shared") =>
        buildFusedCodeBlock({
          projectId: PROJECT,
          query: "fee",
          ragChunks: [],
          enabled: true,
          tokenBudget: 1500,
          maxSymbols: 12,
          searcher,
          lineLookup,
          hiddenSymbols: hiddenSymbolsFor(() =>
            userId === "shared"
              ? loadSharedCodeAccess(PROJECT)
              : loadCodeAccessFilter({ projectId: PROJECT, userId }),
          ),
        });

      it("leaves a restricted file's symbol out for Bob, neither shown nor counted", async () => {
        const r = await block(BOB);
        expect(r.usedSymbols).toBe(1);
        expect(r.block).toContain("computeFee");
        expect(r.block).not.toContain("computeSecretFee");
        expect(r.block).not.toContain(SECRET_LINE);
      });

      it("keeps it for Alice, and leaves it out for a shared audience", async () => {
        const r = await block(ALICE);
        expect(r.hits.map((h) => h.symbolId)).toEqual(["s-secret", "s-public"]);
        expect((await block("shared")).hits.map((h) => h.symbolId)).toEqual(["s-public"]);
      });

      it("builds no block at all when the reader's access cannot be read", async () => {
        const r = await block(GONE);
        expect(r).toMatchObject({ block: "", usedSymbols: 0, hits: [] });
      });

      it("the analysis seed (retrieveFusedCodeChunks) passes the filter through", async () => {
        const chunks = await retrieveFusedCodeChunks({
          projectId: PROJECT,
          query: "fee",
          ragChunks: [],
          enabled: true,
          deps: { searcher, lineLookup },
          hiddenSymbols: hiddenSymbolsFor(() => loadSharedCodeAccess(PROJECT)),
        });
        expect(chunks.map((c) => c.symbolId)).toEqual(["s-public"]);
      });

      it("Spec Kit leaves it out by default: an artifact is read by the whole project", async () => {
        const rag = await buildSpecKitRagContext(PROJECT, "fee", {
          knowledgeService: { search: async () => ({ hits: [] }) },
          fusedCode: { searcher, lineLookup },
          includeCode: true,
        });
        expect(rag.context).toContain("computeFee");
        expect(rag.context).not.toContain("computeSecretFee");
        expect(rag.usedSymbols).toBe(1);
        // The shared audience's filter is the one Spec Kit read.
        expect((await loadSharedCodeAccess(PROJECT)).hiddenPaths(REPO)).toEqual(["src/secret.ts"]);
      });
    });

    describe("chat's tool-result cache after a role change", () => {
      it("never answers a call under one role with a result read under another", async () => {
        process.env.CHAT_TOOL_RESULT_CACHE_ENABLED = "1";
        await restrict([{ kind: "role", value: "developer" }]);
        const raw = createSearchSymbolsTool({ searcher, lineLookup });
        const tool = codeRuntimeTool(raw, raw.name);
        const ctx = { sessionId: "s-1", userId: CAROL, projectId: PROJECT };
        const ask = async () => (await tool.execute({ query: "fee" }, ctx)).text;

        expect(await ask()).not.toContain("computeSecretFee"); // reader: restricted out
        await setRole(CAROL, "developer");
        expect(await ask()).toContain("computeSecretFee"); // promoted: the next call sees it
        await setRole(CAROL, "reader");
        expect(await ask()).not.toContain("computeSecretFee"); // demoted: hidden again at once
        // Sanity: what the tools read for Carol now is the reader's view.
        const now = await loadCodeAccessFilter({ projectId: PROJECT, userId: CAROL });
        expect(now.isHidden(REPO, "src/secret.ts")).toBe(true);
      });
    });
  },
);
