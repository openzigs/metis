/**
 * #2314 — document access for code reads outside chat's three code tools
 * (#2243 covered those), over a real SQLite database built by the migration
 * chain and a real clone on disk.
 *
 * `src/secret.ts` is ingested as a document restricted to its owner, Alice:
 *   - the analysis code agent's `read_file_slice` and `list_files` (the bare
 *     tools, with the `codeAccess` the orchestrator now sets) neither read nor
 *     list it for Bob, and the refusal reads like a missing file; Alice still
 *     can; a scheduled run (`SYSTEM_ACTOR_ID`) or one with no requester reads
 *     as a shared audience; an inactive requester is refused outright;
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
// The content version must not probe an embedding sidecar.
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));

const {
  hiddenSymbolsFor,
  loadAnalysisCodeAccess,
  loadCodeAccessFilter,
  loadSharedCodeAccess,
  UNRESTRICTED_CODE_ACCESS,
} = await import("../src/lib/analysis/tools/code-access.js");
const { readFileSliceTool, FILE_NOT_FOUND } =
  await import("../src/lib/analysis/tools/read-file-slice.js");
const { listFilesTool } = await import("../src/lib/analysis/tools/list-files.js");
const { buildFusedCodeBlock } = await import("../src/lib/rag/fused-code-context.js");
const { retrieveFusedCodeChunks } = await import("../src/lib/analysis/fused-code-chunks.js");
const { buildSpecKitRagContext } = await import("../src/lib/spec-kit/rag-context.js");
const { codeRuntimeTool } = await import("../src/lib/ai/tool-runtime/toolset.js");
const { createSearchSymbolsTool } = await import("../src/lib/analysis/tools/search-symbols.js");
const { __resetToolResultCacheForTests } =
  await import("../src/lib/ai/tool-runtime/tool-result-cache.js");
const { InactiveAclActorError } = await import("../src/lib/rag/acl.js");
const { SYSTEM_ACTOR_ID } = await import("../src/lib/audit/system-actor.js");

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
    let clone: string;
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
    const analysisCtx = async (
      actorId: string | undefined,
      connectorId: string | undefined = REPO,
    ) =>
      ({
        projectId: PROJECT,
        ...(connectorId ? { connectorId } : {}),
        cloneDir: clone,
        codeAccess: await loadAnalysisCodeAccess(PROJECT, actorId),
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

      clone = mkdtempSync(path.join(os.tmpdir(), "metis-2314-"));
      mkdirSync(path.join(clone, "src"));
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
      if (clone) rmSync(clone, { recursive: true, force: true });
    });

    describe("the analysis code agent's read_file_slice", () => {
      it("refuses a restricted file to Bob, under any spelling or through a symlink, as if it were missing", async () => {
        const ctx = await analysisCtx(BOB);
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

      it("reads it for Alice, and for a context with no access filter (an eval harness)", async () => {
        const alice = await readFileSliceTool.execute(
          { filePath: "src/secret.ts" },
          await analysisCtx(ALICE),
        );
        expect(alice.content).toContain(SECRET_LINE);
        const bare = await readFileSliceTool.execute(
          { filePath: "src/secret.ts" },
          { projectId: PROJECT, connectorId: REPO, cloneDir: clone },
        );
        expect(bare.content).toContain(SECRET_LINE);
      });

      it("reads a scheduled run, or one with no requester, as a shared audience: not even Alice's file", async () => {
        for (const actor of [SYSTEM_ACTOR_ID, undefined]) {
          const r = await readFileSliceTool.execute(
            { filePath: "src/secret.ts" },
            await analysisCtx(actor),
          );
          expect(r.isError, String(actor)).toBe(true);
        }
      });

      it("matches a clone of unknown repository against every repository's restrictions", async () => {
        const r = await readFileSliceTool.execute(
          { filePath: "src/secret.ts" },
          await analysisCtx(BOB, undefined),
        );
        expect(r).toEqual({ content: `${FILE_NOT_FOUND} src/secret.ts`, isError: true });
      });

      it("reads the whole repository once the restriction is lifted", async () => {
        await restrict([]);
        const ctx = await analysisCtx(BOB);
        expect(ctx.codeAccess).toBe(UNRESTRICTED_CODE_ACCESS);
        const r = await readFileSliceTool.execute({ filePath: "src/secret.ts" }, ctx);
        expect(r.content).toContain(SECRET_LINE);
      });
    });

    describe("the analysis code agent's list_files", () => {
      it("neither lists nor counts a restricted file for Bob, and lists it for Alice", async () => {
        const bob = await listFilesTool.execute({ pattern: "src/*.ts" }, await analysisCtx(BOB));
        expect(bob.content).toContain("src/public.ts");
        expect(bob.content).not.toContain("secret");
        expect(bob.resultCount).toBe(1);
        const alice = await listFilesTool.execute(
          { pattern: "src/*.ts" },
          await analysisCtx(ALICE),
        );
        expect(alice.content).toContain("src/secret.ts");
        expect(alice.resultCount).toBe(2);
      });
    });

    it("refuses an inactive requester: the pass fails rather than read unfiltered", async () => {
      await expect(loadAnalysisCodeAccess(PROJECT, GONE)).rejects.toBeInstanceOf(
        InactiveAclActorError,
      );
    });

    describe("fused symbol retrieval", () => {
      const block = (actorId: string | undefined) =>
        buildFusedCodeBlock({
          projectId: PROJECT,
          query: "fee",
          ragChunks: [],
          enabled: true,
          tokenBudget: 1500,
          maxSymbols: 12,
          searcher,
          lineLookup,
          hiddenSymbols: hiddenSymbolsFor(() => loadAnalysisCodeAccess(PROJECT, actorId)),
        });

      it("leaves a restricted file's symbol out for Bob, neither shown nor counted", async () => {
        const r = await block(BOB);
        expect(r.usedSymbols).toBe(1);
        expect(r.block).toContain("computeFee");
        expect(r.block).not.toContain("computeSecretFee");
        expect(r.block).not.toContain(SECRET_LINE);
      });

      it("keeps it for Alice", async () => {
        const r = await block(ALICE);
        expect(r.hits.map((h) => h.symbolId)).toEqual(["s-secret", "s-public"]);
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
          hiddenSymbols: hiddenSymbolsFor(() => loadAnalysisCodeAccess(PROJECT, BOB)),
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
