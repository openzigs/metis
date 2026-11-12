/**
 * #2325 — every chat code and knowledge tool result states which version of
 * the code it describes.
 *
 * The tools run exactly as chat offers them (`getChatCodeTools`, wrapped by
 * `codeRuntimeTool`; `search-knowledge` through its registry builder) over a
 * real SQLite database built by the migration chain and a real clone on disk.
 * Only the symbol searcher's ranking is scripted. The project's GitHub
 * connector is indexed at `INDEXED`; the clone's `.git/HEAD` is written by
 * hand, at `INDEXED` or moved on to `MOVED_ON`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import type { RetrievedChunk } from "@metis/shared";
import type { RuntimeTool, RuntimeToolContext } from "../src/lib/ai/tool-runtime/types.js";

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
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));
vi.mock("../src/lib/rag/acl.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/acl.js")>()),
  resolveAclActor: async (userId: string) => ({ userId, role: "reader" }),
}));

const { codeRuntimeTool } = await import("../src/lib/ai/tool-runtime/toolset.js");
const { getChatCodeTools } = await import("../src/lib/analysis/tools/index.js");
const { buildSearchKnowledgeTool } = await import("../src/lib/rag/search-knowledge-tool.js");
const { createChatReadFileSliceTool } =
  await import("../src/lib/analysis/tools/chat-read-file-slice.js");

const USER = "u-ana";
const PROJECT = "p-ver";
const REPO = "rc-ver";
const GRAPH = "g-ver";
const INDEXED = "0123456789abcdef0123456789abcdef01234567";
const MOVED_ON = "fedcba9876543210fedcba9876543210fedcba98";
const LINK = `https://github.com/acme/reader/blob/${INDEXED}`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2325 — the citation contract on chat's code and knowledge tools (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let clone: string;
    let tools: Record<"graph" | "symbols" | "slice", RuntimeTool>;
    const ctx: RuntimeToolContext = { sessionId: "s-1", userId: USER, projectId: PROJECT };
    const setHead = (sha: string) => writeFileSync(path.join(clone, ".git", "HEAD"), `${sha}\n`);

    beforeAll(async () => {
      process.env.CHAT_TOOL_RESULT_CACHE_ENABLED = "0";
      sqlite = createMigratedSqlite("chat-citation-contract-2325");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: "ana", displayName: "Ana", email: "ana@example.test" },
      });
      await db.project.create({
        data: { id: PROJECT, name: "Reader", slug: PROJECT, createdById: USER },
      });
      await db.repoConnection.create({
        data: {
          id: REPO,
          projectId: PROJECT,
          label: "reader",
          provider: "github",
          ownerOrOrg: "acme",
          repoName: "reader",
          isPrimary: true,
          lastCommitSha: INDEXED,
        },
      });
      await db.codeGraph.create({
        data: {
          id: GRAPH,
          projectId: PROJECT,
          repoConnectionId: REPO,
          commitSha: INDEXED,
          lastIndexedAt: new Date(),
        },
      });
      await db.codeSymbol.create({
        data: {
          id: "s-feed",
          codeGraphId: GRAPH,
          projectId: PROJECT,
          kind: "function",
          name: "refreshFeed",
          qualifiedName: "internal/feed.go::refreshFeed",
          filePath: "internal/feed.go",
          startLine: 2,
          endLine: 4,
          language: "go",
          contentHash: "h",
        },
      });

      clone = mkdtempSync(path.join(os.tmpdir(), "metis-2325-"));
      mkdirSync(path.join(clone, "internal"));
      mkdirSync(path.join(clone, ".git"));
      writeFileSync(
        path.join(clone, "internal", "feed.go"),
        "package feed\nfunc refreshFeed() {\n\treturn\n}\n",
      );

      const [graph, symbols] = getChatCodeTools({
        searcher: {
          search: async () => [
            {
              symbolId: "s-feed",
              filePath: "internal/feed.go",
              name: "refreshFeed",
              kind: "function",
              score: 0.9,
              matchedBy: ["lexical"],
            },
          ],
        },
      });
      // The line lookup is production's: the hit's repository comes from its graph.
      const slice = createChatReadFileSliceTool({ resolveCloneDir: async () => clone });
      tools = {
        graph: codeRuntimeTool(graph!, graph!.name),
        symbols: codeRuntimeTool(symbols!, symbols!.name),
        slice: codeRuntimeTool(slice, slice.name),
      };
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      delete process.env.CHAT_TOOL_RESULT_CACHE_ENABLED;
      await db?.$disconnect();
      sqlite?.cleanup();
      if (clone) rmSync(clone, { recursive: true, force: true });
    });

    it("search_code_graph states the indexed commit and a GitHub link pinned to it", async () => {
      const r = await tools.graph.execute({ query: "refreshFeed" }, ctx);
      expect(r.citations).toEqual([
        expect.objectContaining({
          path: "internal/feed.go",
          startLine: 2,
          endLine: 4,
          commitSha: INDEXED,
          permalink: `${LINK}/internal/feed.go#L2-L4`,
        }),
      ]);
      expect(r.text).toContain("Code version: indexed commit 0123456789ab.");
    });

    it("search_code_symbols states the commit of the hit's repository, and how it matched", async () => {
      const r = await tools.symbols.execute({ query: "refresh feed" }, ctx);
      expect(r.citations).toEqual([
        expect.objectContaining({
          path: "internal/feed.go",
          commitSha: INDEXED,
          permalink: `${LINK}/internal/feed.go#L2-L4`,
          matchedBy: ["lexical"],
        }),
      ]);
    });

    it("read_file_slice is current when the clone is at the indexed commit", async () => {
      setHead(INDEXED);
      const r = await tools.slice.execute({ filePath: "internal/feed.go" }, ctx);
      expect(r.citations?.[0]).toMatchObject({ commitSha: INDEXED, stale: false, totalLines: 5 });
      expect(r.text).not.toContain("Stale");
    });

    it("read_file_slice flags a clone that moved past the index, still serving the lines", async () => {
      setHead(MOVED_ON);
      const r = await tools.slice.execute({ filePath: "internal/feed.go" }, ctx);
      expect(r.isError).toBeUndefined();
      expect(r.text).toContain("2| func refreshFeed() {");
      expect(r.citations?.[0]).toMatchObject({
        commitSha: INDEXED,
        stale: true,
        workingTreeSha: MOVED_ON,
      });
      expect(r.text).toContain("index is behind the repository");
    });

    it("search-knowledge states the commit on a source excerpt of the repository", async () => {
      const hit: RetrievedChunk = {
        chunkId: "c1",
        documentId: "d1",
        filename: `connector:repo:${REPO}:src/internal/feed.go`,
        path: "internal/feed.go",
        position: 0,
        text: "func refreshFeed()",
        score: 0.8,
        embeddingModel: "embed-a",
        source: "repo",
      };
      const tool = buildSearchKnowledgeTool({
        service: { search: async () => ({ hits: [hit], coverageWarning: undefined }) } as never,
      });
      const r = await tool.exec(
        { query: "feed" },
        { sessionId: "s-1", userId: USER, projectId: PROJECT },
      );
      expect(r.citations).toEqual([
        expect.objectContaining({
          path: "internal/feed.go",
          startLine: null,
          commitSha: INDEXED,
          permalink: `${LINK}/internal/feed.go`,
        }),
      ]);
    });

    it("a deleted connector lends no link, and the commit is still stated", async () => {
      await db.repoConnection.update({ where: { id: REPO }, data: { deletedAt: new Date() } });
      try {
        const r = await tools.graph.execute({ query: "refreshFeed" }, ctx);
        expect(r.citations?.[0]).toMatchObject({ commitSha: INDEXED, permalink: null });
      } finally {
        await db.repoConnection.update({ where: { id: REPO }, data: { deletedAt: null } });
      }
    });

    it("#2329 — search_code_context returns the whole symbol with the contract, through production's line lookup", async () => {
      setHead(INDEXED);
      // Production's line lookup, version read and ACL read; the clone's
      // location is the only thing given.
      const { createSearchCodeContextTool } =
        await import("../src/lib/analysis/tools/search-code-context.js");
      const real = createSearchCodeContextTool({
        searcher: {
          search: async () => [
            {
              symbolId: "s-feed",
              filePath: "internal/feed.go",
              name: "refreshFeed",
              kind: "function",
              score: 0.9,
              matchedBy: ["lexical"],
            },
          ],
        },
        resolveCloneDir: async () => clone,
      });
      const r = await codeRuntimeTool(real, real.name).execute({ query: "refresh" }, ctx);
      expect(r.text).toContain("[1] internal/feed.go:2-4 — function refreshFeed");
      expect(r.text).toContain("2| func refreshFeed() {");
      expect(r.text).toContain("4| }");
      expect(r.citations).toEqual([
        expect.objectContaining({
          path: "internal/feed.go",
          startLine: 2,
          endLine: 4,
          commitSha: INDEXED,
          permalink: `${LINK}/internal/feed.go#L2-L4`,
          matchedBy: ["lexical"],
          stale: false,
        }),
      ]);
    });
  },
);
