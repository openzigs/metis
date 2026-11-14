/**
 * #2331 — `metis-index-mcp` runs every call as ONE METIS user, through that
 * user's project access and per-document ACLs, and makes no model call.
 *
 * Driven by a real MCP SDK client over the in-memory transport, against a real
 * SQLite database built by the migration chain, real API-token rows (verified
 * by the real `verifyApiToken`) and a real clone on disk. The symbol searcher
 * is production's (`createDefaultCodeSearcher`: hybrid BM25 + vector over the
 * real symbol rows) with an empty vector store and a constant embedder, so
 * ranking is lexical and no embedding sidecar is needed.
 *
 *   - Alice and Bob are members of the project's workspace; `src/secret.ts` is
 *     a document restricted to Alice. The SAME call gives Alice the file and
 *     its symbol, caller and context, and Bob none of them.
 *   - Carol is in another workspace: the project is absent from her
 *     `metis_list_projects`, and a call naming it answers as a missing project.
 *   - A static shared token, an unknown or revoked token, a token without
 *     `acp:read`, and a disabled user's token are all refused before any read;
 *     revoking a token applies to the very next call.
 *   - No tool path constructs a model provider or an Anthropic client, or
 *     calls `fetch`.
 *   - The audit records carry user, tool, project and result count, never a
 *     result body or a query.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({
  db: null as unknown,
  clone: "",
  providerBuilds: 0,
  anthropicClients: 0,
}));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/analysis/clone-availability.js", async (original) => ({
  ...(await original<typeof import("../src/lib/analysis/clone-availability.js")>()),
  resolveExistingCloneDir: async (id: string | undefined) =>
    id === "rc-app" ? state.clone : undefined,
}));
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));
// Every way METIS builds a model provider, counted.
vi.mock("../src/lib/ai/providers/factory.js", async (original) => {
  const real = await original<typeof import("../src/lib/ai/providers/factory.js")>();
  return {
    ...real,
    buildProvider: (...a: Parameters<typeof real.buildProvider>) => {
      state.providerBuilds++;
      return real.buildProvider(...a);
    },
    getProvider: (...a: Parameters<typeof real.getProvider>) => {
      state.providerBuilds++;
      return real.getProvider(...a);
    },
  };
});
vi.mock("../src/lib/ai/server-provider.js", async (original) => {
  const real = await original<typeof import("../src/lib/ai/server-provider.js")>();
  return {
    ...real,
    buildServerProvider: (...a: Parameters<typeof real.buildServerProvider>) => {
      state.providerBuilds++;
      return real.buildServerProvider(...a);
    },
  };
});
vi.mock("../src/lib/ai/project-provider.js", async (original) => {
  const real = await original<typeof import("../src/lib/ai/project-provider.js")>();
  return {
    ...real,
    resolveProjectProvider: (...a: Parameters<typeof real.resolveProjectProvider>) => {
      state.providerBuilds++;
      return real.resolveProjectProvider(...a);
    },
  };
});
vi.mock("@anthropic-ai/sdk", async (original) => {
  const real = await original<typeof import("@anthropic-ai/sdk")>();
  class CountedAnthropic extends real.default {
    constructor(...a: ConstructorParameters<typeof real.default>) {
      state.anthropicClients++;
      super(...a);
    }
  }
  return { ...real, default: CountedAnthropic, Anthropic: CountedAnthropic };
});

const { createIndexMcpServer } = await import("../src/mcp/metis-index/server.js");
const { createDefaultCodeSearcher } =
  await import("../src/lib/code-graph/project-code-searcher.js");

const ALICE = "u-alice";
const BOB = "u-bob";
const CAROL = "u-carol";
const GONE = "u-gone";
const WS = "w-billing";
const WS_OTHER = "w-other";
const PROJECT = "p-billing";
const OTHER = "p-other";
const REPO = "rc-app";
const GRAPH = "g-app";
const SECRET_DOC = "d-secret";
const SECRET_LINE = "export const SECRET_RATE = 0.42;";
/** Built, not written: a literal key-shaped string trips the repository's secret scanners. */
const AWS_KEY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");

const token = (who: string): string => `metis_${createHash("sha256").update(who).digest("hex")}`;
const sha = (s: string): string => createHash("sha256").update(s, "utf-8").digest("hex");

interface AuditEntry {
  actor?: unknown;
  action: string;
  target: { type: string; id: string };
  metadata?: Record<string, unknown>;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2331 — metis-index-mcp: per-user identity, ACLs, no model call (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let clone: string;
    const audits: AuditEntry[] = [];
    const fetchSpy = vi.fn();
    const realFetch = globalThis.fetch;

    const searcher = () =>
      createDefaultCodeSearcher({
        vectorStore: { search: async () => [] },
        embedService: {
          embed: async (texts: string[]) => ({
            vectors: texts.map(() => [1, 0, 0]),
            model: "embed-a",
            dimension: 3,
          }),
        },
      });

    async function connect(credential: string) {
      const server = createIndexMcpServer({
        credential,
        audit: (e) => audits.push(e as AuditEntry),
        log: () => {},
        deps: { code: { searcher: searcher() } },
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t-2331", version: "0.0.0" });
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      return {
        async call(name: string, args: Record<string, unknown> = {}) {
          const r = await client.callTool({ name, arguments: args });
          const text = (r.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
          return {
            isError: r.isError === true,
            text,
            out: r.structuredContent as
              | {
                  result: string;
                  resultCount: number | null;
                  truncated: boolean;
                  citations: Array<{ path: string; commitSha: string | null }>;
                  instructions: string | null;
                }
              | undefined,
          };
        },
        async close() {
          await client.close();
          await server.close();
        },
      };
    }

    beforeAll(async () => {
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      sqlite = createMigratedSqlite("mcp-metis-index-2331");
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
      await db.workspace.create({ data: { id: WS, name: "Billing", slug: WS } });
      await db.workspace.create({ data: { id: WS_OTHER, name: "Other", slug: WS_OTHER } });
      for (const [workspaceId, userId] of [
        [WS, ALICE],
        [WS, BOB],
        [WS, GONE],
        [WS_OTHER, CAROL],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId, userId } });
      }
      await db.project.create({
        data: {
          id: PROJECT,
          name: "Billing",
          slug: "billing",
          description: `Invoices and fees (ops key ${AWS_KEY})\nSecond line is not shown.`,
          status: "active",
          workspaceId: WS,
          createdById: ALICE,
        },
      });
      await db.project.create({
        data: {
          id: OTHER,
          name: "Other",
          slug: "other",
          status: "active",
          workspaceId: WS_OTHER,
          createdById: CAROL,
        },
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
      const sym = (id: string, name: string, filePath: string, startLine: number) =>
        db.codeSymbol.create({
          data: {
            id,
            codeGraphId: GRAPH,
            projectId: PROJECT,
            kind: "function",
            name,
            qualifiedName: `${filePath}::${name}`,
            filePath,
            startLine,
            endLine: startLine + 1,
            language: "ts",
            contentHash: id,
          },
        });
      await sym("s-secret", "computeSecretFee", "src/secret.ts", 2);
      await sym("s-public", "computeFee", "src/public.ts", 1);
      await db.codeEdge.create({
        data: {
          codeGraphId: GRAPH,
          projectId: PROJECT,
          kind: "calls",
          fromSymbolId: "s-secret",
          toSymbolId: "s-public",
          filePath: "src/secret.ts",
          line: 3,
        },
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

      clone = mkdtempSync(path.join(os.tmpdir(), "metis-2331-"));
      mkdirSync(path.join(clone, "src"));
      writeFileSync(
        path.join(clone, "src", "secret.ts"),
        `${SECRET_LINE}\nexport function computeSecretFee() {\n  return computeFee() * SECRET_RATE;\n}\n`,
      );
      writeFileSync(
        path.join(clone, "src", "public.ts"),
        "export function computeFee() {\n  return 1;\n}\n",
      );
      state.clone = clone;

      const tok = (id: string, userId: string, scopes: string[], extra = {}) =>
        db.apiToken.create({
          data: {
            id,
            userId,
            name: id,
            tokenHash: sha(token(id)),
            prefix: token(id).slice(0, 14),
            scopes: JSON.stringify(scopes),
            ...extra,
          },
        });
      await tok("t-alice", ALICE, ["acp:read", "acp:run"]);
      await tok("t-bob", BOB, ["acp:read"]);
      await tok("t-carol", CAROL, ["acp:*"]);
      await tok("t-gone", GONE, ["acp:read"]);
      await tok("t-run-only", ALICE, ["acp:run"]);
      await tok("t-revoked", ALICE, ["acp:read"], { revokedAt: new Date() });
      await tok("t-expired", ALICE, ["acp:read"], { expiresAt: new Date(Date.now() - 1000) });
      await tok("t-alice-2", ALICE, ["acp:read"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      globalThis.fetch = realFetch;
      await db?.$disconnect();
      sqlite?.cleanup();
      if (clone) rmSync(clone, { recursive: true, force: true });
    });

    describe("the same call, two users with different access", () => {
      it("reads the restricted file for Alice, and answers Bob as if it did not exist", async () => {
        const alice = await connect(token("t-alice"));
        const bob = await connect(token("t-bob"));
        try {
          const args = { projectId: PROJECT, filePath: "src/secret.ts" };
          const a = await alice.call("metis_read_file_slice", args);
          const b = await bob.call("metis_read_file_slice", args);
          expect(a.isError).toBe(false);
          expect(a.out!.result).toContain(SECRET_LINE);
          expect(a.out!.citations[0]).toMatchObject({
            path: "src/secret.ts",
            commitSha: "a".repeat(40),
          });
          expect(a.out!.instructions).toMatch(/^Instructions from METIS/);
          expect(b.isError).toBe(true);
          expect(b.text).not.toContain(SECRET_LINE);
          const missing = await bob.call("metis_read_file_slice", {
            projectId: PROJECT,
            filePath: "src/nope.ts",
          });
          expect(b.text.replace("src/secret.ts", "X")).toBe(
            missing.text.replace("src/nope.ts", "X"),
          );
        } finally {
          await alice.close();
          await bob.close();
        }
      });

      it("finds the restricted symbol, its call edge and its context for Alice only", async () => {
        const alice = await connect(token("t-alice"));
        const bob = await connect(token("t-bob"));
        try {
          for (const [tool, args] of [
            ["metis_search_symbols", { projectId: PROJECT, query: "compute fee" }],
            ["metis_search_code_context", { projectId: PROJECT, query: "compute fee" }],
            ["metis_graph_callers", { projectId: PROJECT, symbol: "computeFee" }],
          ] as const) {
            const a = await alice.call(tool, args);
            const b = await bob.call(tool, args);
            expect(a.isError, `${tool} alice: ${a.text}`).toBe(false);
            expect(b.isError, `${tool} bob: ${b.text}`).toBe(false);
            expect(a.out!.result, tool).toContain("computeSecretFee");
            expect(b.out!.result, tool).not.toContain("computeSecretFee");
            expect(
              b.out!.citations.map((c) => c.path),
              tool,
            ).not.toContain("src/secret.ts");
          }
          // And the callee direction from the restricted symbol is Alice's alone.
          const ac = await alice.call("metis_graph_callees", {
            projectId: PROJECT,
            symbol: "computeSecretFee",
          });
          const bc = await bob.call("metis_graph_callees", {
            projectId: PROJECT,
            symbol: "computeSecretFee",
          });
          expect(ac.out!.result).toContain("computeFee");
          expect(bc.out?.result ?? bc.text).not.toContain("src/public.ts:1");
        } finally {
          await alice.close();
          await bob.close();
        }
      });
    });

    describe("project access", () => {
      it("lists only readable projects, one description line, redacted", async () => {
        const alice = await connect(token("t-alice"));
        const carol = await connect(token("t-carol"));
        try {
          const a = await alice.call("metis_list_projects");
          expect(a.out!.result).toContain(`${PROJECT} — Billing (billing): Invoices and fees`);
          expect(a.out!.result).not.toContain(OTHER);
          expect(a.out!.result).not.toContain("Second line");
          expect(a.out!.result).not.toContain(AWS_KEY);
          expect(a.out!.result).toContain("[REDACTED:aws_key]");
          expect(a.out!.resultCount).toBe(1);
          const c = await carol.call("metis_list_projects");
          expect(c.out!.result).toContain(OTHER);
          expect(c.out!.result).not.toContain(PROJECT);
        } finally {
          await alice.close();
          await carol.close();
        }
      });

      it("answers a project the caller cannot read exactly as one that does not exist", async () => {
        const carol = await connect(token("t-carol"));
        try {
          for (const tool of [
            "metis_index_status",
            "metis_read_requirements",
            "metis_search_symbols",
          ]) {
            const args = tool === "metis_search_symbols" ? { query: "fee" } : {};
            const forbidden = await carol.call(tool, { ...args, projectId: PROJECT });
            const missing = await carol.call(tool, { ...args, projectId: "p-missing" });
            expect(forbidden.isError, tool).toBe(true);
            expect(forbidden.text, tool).toBe(missing.text);
            expect(forbidden.text, tool).toMatch(/project not found/);
          }
        } finally {
          await carol.close();
        }
      });

      it("reads index status and requirements for a member", async () => {
        const alice = await connect(token("t-alice"));
        try {
          const s = await alice.call("metis_index_status", { projectId: PROJECT });
          expect(s.isError, s.text).toBe(false);
          expect(s.out!.instructions).toMatch(/index is failed, partial/);
          const r = await alice.call("metis_read_requirements", { projectId: PROJECT });
          expect(r.isError, r.text).toBe(false);
          expect(r.out!.resultCount).toBe(0);
          expect(r.out!.instructions).toMatch(/nothing was found/);
        } finally {
          await alice.close();
        }
      });
    });

    describe("identity: the credential must be one user's own live token", () => {
      it.each([
        ["a static shared token", "svc_shared_static_secret"],
        ["an unknown metis_ token", token("t-never-issued")],
        ["a revoked token", token("t-revoked")],
        ["an expired token", token("t-expired")],
        ["a token without acp:read", token("t-run-only")],
        ["a disabled user's token", token("t-gone")],
        ["no token", ""],
      ])("refuses %s on every tool, before any read", async (_label, credential) => {
        const before = audits.length;
        const c = await connect(credential);
        try {
          for (const tool of ["metis_list_projects", "metis_read_file_slice"]) {
            const r = await c.call(
              tool,
              tool === "metis_list_projects"
                ? {}
                : { projectId: PROJECT, filePath: "src/public.ts" },
            );
            expect(r.isError).toBe(true);
            expect(r.text).toMatch(/METIS refused the credential/);
            expect(r.text).not.toContain("computeFee");
          }
        } finally {
          await c.close();
        }
        const fresh = audits.slice(before);
        expect(fresh.map((e) => e.action)).toEqual(["mcp.index.denied", "mcp.index.denied"]);
      });

      it("applies a revocation to the very next call", async () => {
        const c = await connect(token("t-alice-2"));
        try {
          expect((await c.call("metis_list_projects")).isError).toBe(false);
          await db.apiToken.update({ where: { id: "t-alice-2" }, data: { revokedAt: new Date() } });
          expect((await c.call("metis_list_projects")).isError).toBe(true);
        } finally {
          await c.close();
        }
      });
    });

    it("makes no model call on any tool path, and audits without bodies", async () => {
      const alice = await connect(token("t-alice"));
      const before = audits.length;
      try {
        const calls: Array<[string, Record<string, unknown>]> = [
          ["metis_list_projects", {}],
          ["metis_search_code_context", { projectId: PROJECT, query: "secret rate fee" }],
          ["metis_search_symbols", { projectId: PROJECT, query: "secret rate fee", limit: 5 }],
          ["metis_graph_callers", { projectId: PROJECT, symbol: "computeFee" }],
          ["metis_graph_callees", { projectId: PROJECT, symbol: "computeSecretFee" }],
          ["metis_read_file_slice", { projectId: PROJECT, filePath: "src/secret.ts" }],
          ["metis_read_requirements", { projectId: PROJECT, status: "approved" }],
          ["metis_index_status", { projectId: PROJECT }],
        ];
        for (const [tool, args] of calls) {
          const r = await alice.call(tool, args);
          expect(r.isError, `${tool}: ${r.text}`).toBe(false);
        }
      } finally {
        await alice.close();
      }
      expect(state.providerBuilds).toBe(0);
      expect(state.anthropicClients).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();

      const fresh = audits.slice(before);
      expect(fresh).toHaveLength(8);
      for (const e of fresh) {
        expect(e.action).toBe("mcp.index.tool_call");
        expect(e.actor).toEqual({ id: ALICE });
        expect(e.metadata).toMatchObject({ tokenId: "t-alice", isError: false });
        expect(Object.keys(e.metadata!).sort()).toEqual(
          ["isError", "projectId", "resultCount", "tokenId", "tool", "truncated"].sort(),
        );
      }
      expect(fresh.find((e) => e.metadata!.tool === "metis_search_symbols")).toMatchObject({
        target: { type: "project", id: PROJECT },
        metadata: { projectId: PROJECT, resultCount: expect.any(Number) },
      });
      const logged = JSON.stringify(fresh);
      expect(logged).not.toContain(SECRET_LINE);
      expect(logged).not.toContain("secret rate fee");
      expect(logged).not.toContain("computeSecretFee");
    });
  },
);
