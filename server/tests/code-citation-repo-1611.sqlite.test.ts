/**
 * #1611 — a code citation names the repository its file came from.
 *
 * One project holds two repo connections, A and B, and BOTH contain
 * `src/auth.ts`. A citation grounded in the symbol retrieved from repo B must
 * carry repo B, read from the symbol's code graph, and never repo A or the repo
 * the model claimed.
 *
 * Real SQLite built by the migration chain and the real production line lookup
 * (`createDefaultSymbolLineLookup`, which reads `CodeSymbol` → `CodeGraph`).
 * Only the ranked searcher is a double: it returns repo B's symbol, the way a
 * search would that matched B's file.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { Citation } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});

const { createDefaultSymbolLineLookup } =
  await import("../src/lib/code-graph/project-code-searcher.js");
const { retrieveFusedCodeChunks } = await import("../src/lib/analysis/fused-code-chunks.js");
const { buildCodeProvenance, groundCodeCitations } =
  await import("../src/lib/analysis/code-citations.js");

const PROJ = "proj-1611";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1611 — a grounded code citation carries the repo of the symbol it was retrieved from",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const repo: Record<"A" | "B", string> = { A: "", B: "" };
    const authSymbol: Record<"A" | "B", string> = { A: "", B: "" };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1611-code-citation-repo");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "alice", username: "alice", displayName: "alice", email: "a@example.test" },
      });
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, createdById: "alice", status: "active" },
      });
      for (const key of ["A", "B"] as const) {
        repo[key] = (
          await db.repoConnection.create({
            data: {
              projectId: PROJ,
              label: `repo-${key}`,
              repoName: `repo-${key}`,
              createdById: "alice",
            },
          })
        ).id;
        const graph = await db.codeGraph.create({
          data: { projectId: PROJ, repoConnectionId: repo[key] },
        });
        authSymbol[key] = (
          await db.codeSymbol.create({
            data: {
              codeGraphId: graph.id,
              projectId: PROJ,
              kind: "function",
              name: "login",
              qualifiedName: "src/auth.ts::login",
              filePath: "src/auth.ts",
              startLine: key === "A" ? 5 : 40,
              endLine: key === "A" ? 20 : 60,
              language: "typescript",
              contentHash: `auth-${key}`,
            },
          })
        ).id;
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("stamps repo B, read from B's code graph, on a citation retrieved from repo B", async () => {
      const chunks = await retrieveFusedCodeChunks({
        projectId: PROJ,
        query: "login",
        ragChunks: [],
        enabled: true,
        deps: {
          searcher: {
            async search() {
              return [
                {
                  symbolId: authSymbol.B,
                  filePath: "src/auth.ts",
                  name: "login",
                  kind: "function",
                  score: 0.9,
                },
              ];
            },
          },
          lineLookup: createDefaultSymbolLineLookup(),
        },
      });
      expect(chunks).toEqual([
        expect.objectContaining({ symbolId: authSymbol.B, repoConnectionId: repo.B }),
      ]);

      // The model cites the shared path and claims a repo that is not B.
      const cited: Citation[] = [
        { filePath: "src/auth.ts", startLine: 41, endLine: 50, repoConnectionId: repo.A },
      ];
      const [grounded] = groundCodeCitations(cited, buildCodeProvenance(chunks));
      expect(grounded).toMatchObject({ filePath: "src/auth.ts", repoConnectionId: repo.B });
      expect(grounded).not.toMatchObject({ repoConnectionId: repo.A });
    });
  },
);
