/**
 * #2243 — chat's code tools honour document access restrictions.
 *
 * `read_file_slice`, `search_code_symbols` and `search_code_graph` are driven
 * exactly as chat offers them (`codeRuntimeTool`), over a real SQLite database
 * built by the migration chain and a real clone on disk. Only the symbol
 * searcher's ranking is scripted (it returns both symbols); which of its hits
 * survive is decided by the real document and symbol rows.
 *
 * `src/secret.ts` is ingested as a document restricted to its owner, Alice:
 *   - Bob is restricted out: he cannot slice it (under any spelling, or through
 *     an in-repo symlink), and gets no symbol or graph hit from it; the refusal
 *     reads like a missing file;
 *   - Alice still can;
 *   - a shared-audience reply (#2248) cannot, even when Alice triggered it;
 *   - unrestricted files, and the whole repository once the restriction is
 *     lifted, read exactly as the tools read them with no filter at all;
 *   - the tool-result cache never hands Alice's read to Bob.
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
import type { RuntimeTool, RuntimeToolContext } from "../src/lib/ai/tool-runtime/types.js";
import type { AgentTool } from "../src/lib/analysis/tools/types.js";

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

const { codeRuntimeTool } = await import("../src/lib/ai/tool-runtime/toolset.js");
const { searchCodeGraphTool } = await import("../src/lib/analysis/tools/search-code-graph.js");
const { createSearchSymbolsTool } = await import("../src/lib/analysis/tools/search-symbols.js");
const { createChatReadFileSliceTool } =
  await import("../src/lib/analysis/tools/chat-read-file-slice.js");
const { __resetToolResultCacheForTests } =
  await import("../src/lib/ai/tool-runtime/tool-result-cache.js");

const ALICE = "u-alice";
const BOB = "u-bob";
const GONE = "u-gone";
const PROJECT = "p-code";
const REPO = "rc-app";
const GRAPH = "g-app";
const SECRET_DOC = "d-secret";
const SECRET_LINE = "export const SECRET_RATE = 0.42;";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2243 — chat code tools honour document ACLs (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let clone: string;
    let raw: { graph: AgentTool; symbols: AgentTool; slice: AgentTool };
    let tools: { graph: RuntimeTool; symbols: RuntimeTool; slice: RuntimeTool };

    const ctx = (userId: string, shared = false): RuntimeToolContext => ({
      sessionId: "s-1",
      userId,
      projectId: PROJECT,
      ...(shared ? { aclAudience: "shared" as const } : {}),
    });
    const restrict = (subjects: Array<{ kind: string; value: string }>) =>
      db.document.update({
        where: { id: SECRET_DOC },
        data: { aclSubjects: JSON.stringify(subjects) },
      });
    const run = (t: RuntimeTool, args: object, c: RuntimeToolContext) => t.execute(args, c);

    beforeAll(async () => {
      process.env.CHAT_TOOL_RESULT_CACHE_ENABLED = "0";
      sqlite = createMigratedSqlite("chat-code-tools-acl-2243");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const [id, name] of [
        [ALICE, "alice"],
        [BOB, "bob"],
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
      const sym = (id: string, name: string, filePath: string) =>
        db.codeSymbol.create({
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
      await sym("s-secret", "computeSecretFee", "src/secret.ts");
      await sym("s-public", "computeFee", "src/public.ts");
      await sym("s-caller", "chargeCard", "src/public.ts");
      // computeSecretFee -> computeFee (resolved), chargeCard -> computeFee
      // (resolved), and a call from secret.ts the parser could not bind.
      await db.codeEdge.createMany({
        data: [
          {
            codeGraphId: GRAPH,
            projectId: PROJECT,
            kind: "calls",
            fromSymbolId: "s-secret",
            toSymbolId: "s-public",
            filePath: "src/secret.ts",
            line: 2,
          },
          {
            codeGraphId: GRAPH,
            projectId: PROJECT,
            kind: "calls",
            fromSymbolId: "s-caller",
            toSymbolId: "s-public",
            filePath: "src/public.ts",
            line: 6,
          },
          {
            codeGraphId: GRAPH,
            projectId: PROJECT,
            kind: "calls",
            fromSymbolId: "s-secret",
            toSymbolId: null,
            toQualifiedName: "rates.computeFee",
            filePath: "src/secret.ts",
            line: 3,
          },
        ],
      });
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

      clone = mkdtempSync(path.join(os.tmpdir(), "metis-2243-"));
      mkdirSync(path.join(clone, "src"));
      writeFileSync(
        path.join(clone, "src", "secret.ts"),
        `${SECRET_LINE}\nexport function computeSecretFee() {}\n`,
      );
      writeFileSync(path.join(clone, "src", "public.ts"), "export function computeFee() {}\n");
      symlinkSync("secret.ts", path.join(clone, "src", "alias.ts"));

      raw = {
        graph: searchCodeGraphTool,
        symbols: createSearchSymbolsTool({
          searcher: {
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
          },
          lineLookup: {
            resolve: async (ids: string[]) =>
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
          },
        }),
        // Repo ids come from the real `repo_connections` rows; only the clone
        // location is given.
        slice: createChatReadFileSliceTool({ resolveCloneDir: async () => clone }),
      };
      tools = {
        graph: codeRuntimeTool(raw.graph, raw.graph.name),
        symbols: codeRuntimeTool(raw.symbols, raw.symbols.name),
        slice: codeRuntimeTool(raw.slice, raw.slice.name),
      };
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      process.env.CHAT_TOOL_RESULT_CACHE_ENABLED = "0";
      __resetToolResultCacheForTests();
      await restrict([{ kind: "user", value: ALICE }]);
    });

    afterAll(async () => {
      delete process.env.CHAT_TOOL_RESULT_CACHE_ENABLED;
      await db?.$disconnect();
      sqlite?.cleanup();
      if (clone) rmSync(clone, { recursive: true, force: true });
    });

    describe("a user restricted out of the file (Bob)", () => {
      it("cannot slice it, under any spelling or through a symlink, and the refusal reads like a missing file", async () => {
        for (const filePath of [
          "src/secret.ts",
          "./src/secret.ts",
          "src/../src/secret.ts",
          "src/alias.ts",
        ]) {
          const r = await run(tools.slice, { filePath }, ctx(BOB));
          expect(r, filePath).toEqual({
            text: `Error: File not found or not accessible: ${filePath}`,
            isError: true,
          });
        }
        const missing = await run(tools.slice, { filePath: "src/nope.ts" }, ctx(BOB));
        expect(missing).toEqual({
          text: "Error: File not found or not accessible: src/nope.ts",
          isError: true,
        });
      });

      it("gets no symbol hit from it", async () => {
        const r = await run(tools.symbols, { query: "fee" }, ctx(BOB));
        expect(r.text).toContain("computeFee");
        expect(r.text).not.toContain("computeSecretFee");
        expect(r.text).not.toContain(SECRET_LINE);
        expect(r.resultCount).toBe(1);
      });

      it("gets no code-graph hit from it, by name, file, caller, callee or probable call site", async () => {
        const byName = await run(tools.graph, { query: "Fee" }, ctx(BOB));
        expect(byName.text).toContain("computeFee");
        expect(byName.text).not.toContain("secret.ts");

        const byFile = await run(tools.graph, { filePath: "secret" }, ctx(BOB));
        expect(byFile).toMatchObject({ resultCount: 0 });
        expect(byFile.text).not.toContain("secret.ts");

        const calledBy = await run(tools.graph, { calledBy: "computeSecretFee" }, ctx(BOB));
        expect(calledBy).toEqual({
          text: 'No symbol matching "computeSecretFee" found.',
          resultCount: 0,
        });

        const calls = await run(tools.graph, { calls: "computeFee" }, ctx(BOB));
        expect(calls.text).toContain("chargeCard");
        expect(calls.text).not.toContain("secret.ts");
        expect(calls.text).not.toContain("computeSecretFee");
      });
    });

    describe("the owner (Alice)", () => {
      it("still reads the file and gets its symbol and graph hits", async () => {
        const slice = await run(tools.slice, { filePath: "src/secret.ts" }, ctx(ALICE));
        expect(slice.text).toContain(SECRET_LINE);
        const viaLink = await run(tools.slice, { filePath: "src/alias.ts" }, ctx(ALICE));
        expect(viaLink.text).toContain(SECRET_LINE);
        const symbols = await run(tools.symbols, { query: "fee" }, ctx(ALICE));
        expect(symbols.text).toContain("computeSecretFee");
        const calls = await run(tools.graph, { calls: "computeFee" }, ctx(ALICE));
        expect(calls.text).toContain("src/secret.ts::computeSecretFee");
        expect(calls.text).toContain("src/secret.ts:3");
        const calledBy = await run(tools.graph, { calledBy: "computeSecretFee" }, ctx(ALICE));
        expect(calledBy.text).toContain("src/public.ts::computeFee");
      });
    });

    describe("a shared-audience reply (#2248)", () => {
      it("sees no restricted file, even when its owner triggered it", async () => {
        const shared = ctx(ALICE, true);
        expect(await run(tools.slice, { filePath: "src/secret.ts" }, shared)).toEqual({
          text: "Error: File not found or not accessible: src/secret.ts",
          isError: true,
        });
        expect((await run(tools.symbols, { query: "fee" }, shared)).text).not.toContain(
          "computeSecretFee",
        );
        expect((await run(tools.graph, { query: "Fee" }, shared)).text).not.toContain("secret.ts");
        // An unrestricted file is still read.
        expect((await run(tools.slice, { filePath: "src/public.ts" }, shared)).text).toContain(
          "computeFee",
        );
      });
    });

    describe("unrestricted files", () => {
      it("read exactly as the tools read them with no filter at all", async () => {
        const bare = { projectId: PROJECT };
        const sliceArgs = { filePath: "src/public.ts" };
        const plain = await raw.slice.execute(sliceArgs, bare);
        expect((await run(tools.slice, sliceArgs, ctx(BOB))).text).toBe(plain.content);
        const missing = await raw.slice.execute({ filePath: "src/nope.ts" }, bare);
        expect(missing.content).toBe("Error: File not found: src/nope.ts");

        // Lift the restriction: every tool answers Bob exactly as it answers
        // with no filter, and a missing file keeps its original wording.
        await restrict([]);
        for (const [t, rt, args] of [
          [raw.slice, tools.slice, { filePath: "src/secret.ts" }],
          [raw.slice, tools.slice, { filePath: "src/nope.ts" }],
          [raw.symbols, tools.symbols, { query: "fee" }],
          [raw.graph, tools.graph, { query: "Fee" }],
          [raw.graph, tools.graph, { calls: "computeFee" }],
        ] as const) {
          const want = await t.execute(args, bare);
          expect((await run(rt, args, ctx(BOB))).text, JSON.stringify(args)).toBe(want.content);
        }
      });
    });

    it("the tool-result cache never hands the owner's read to a restricted user", async () => {
      process.env.CHAT_TOOL_RESULT_CACHE_ENABLED = "1";
      __resetToolResultCacheForTests();
      const args = { filePath: "src/secret.ts" };
      expect((await run(tools.slice, args, ctx(ALICE))).text).toContain(SECRET_LINE);
      // Served from the cache for Alice herself...
      expect((await run(tools.slice, args, ctx(ALICE))).text).toContain(SECRET_LINE);
      // ...never for Bob, nor for a shared reply.
      expect((await run(tools.slice, args, ctx(BOB))).text).not.toContain(SECRET_LINE);
      expect((await run(tools.slice, args, ctx(ALICE, true))).text).not.toContain(SECRET_LINE);
      const symArgs = { query: "fee" };
      expect((await run(tools.symbols, symArgs, ctx(ALICE))).text).toContain("computeSecretFee");
      expect((await run(tools.symbols, symArgs, ctx(BOB))).text).not.toContain("computeSecretFee");
    });

    it("a caller whose ACL actor cannot be resolved reads nothing", async () => {
      await expect(run(tools.slice, { filePath: "src/public.ts" }, ctx(GONE))).rejects.toThrow(
        "ACL actor unavailable",
      );
    });
  },
);
