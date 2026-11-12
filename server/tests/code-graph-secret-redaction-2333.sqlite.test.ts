/**
 * #2333 — the code graph stores no secret from a repository file.
 *
 * What ingest stores from a file's TEXT — a symbol's signature and doc comment,
 * and the embedding text a search hit's body snippet is cut from — is built
 * from the file with its secrets redacted in place. Proven on a real SQLite
 * database built from the migration chain:
 *
 *   1. a full ingest stores no secret in any column or embedding text, and every
 *      symbol's line span is the one an ingest of the same file without the
 *      secret records;
 *   2. a graph stamped with the previous SYMBOL_CONTEXT_VERSION (written before
 *      #2333, secrets and all) has them replaced on its next INCREMENTAL ingest,
 *      on the existing rows, and the changed texts are marked for re-embedding.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestCodeGraph, SYMBOL_CONTEXT_VERSION } from "../src/lib/code-graph/ingest.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const k = (...parts: string[]): string => parts.join("");

const TOKEN = k("ghp_", "Rk4".repeat(12));
const DB_URL_PASSWORD = "Tr0ub4dor3xyz";

/** A file with a secret in a doc comment, a signature default and a body. */
const withSecrets = (token: string, password: string): string =>
  [
    "/**",
    ` * Calls the API with ${token} as the bearer.`,
    " */",
    `export function connect(url = "postgres://app:${password}@db:5432/app"): string {`,
    `  const auth = "${token}";`,
    "  return url + auth;",
    "}",
    "",
    "export function plain(a: number): number {",
    "  return a;",
    "}",
    "",
  ].join("\n");

const TREE = { "src/client.ts": withSecrets(TOKEN, DB_URL_PASSWORD) };
/** Same shape, nothing secret: what the spans must equal. */
const CLEAN_TREE = { "src/client.ts": withSecrets("TOKEN_PLACEHOLDER", "${DB_PASS}") };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2333 — code-graph stored text carries no secret",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2333-secret-redaction");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-2333-"));
      await db.user.create({
        data: {
          id: "u-2333",
          username: "u-2333",
          displayName: "u-2333",
          email: "u-2333@example.test",
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    const newProject = async (tree: Record<string, string>) => {
      seq += 1;
      const p = await db.project.create({
        data: { name: `p2333-${seq}`, slug: `p2333-${seq}`, createdById: "u-2333" },
      });
      const root = path.join(scratch, `tree-${seq}`);
      for (const [rel, content] of Object.entries(tree)) {
        await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), content, "utf8");
      }
      return { projectId: p.id, root };
    };

    const ingest = (projectId: string, root: string, incremental: boolean) =>
      ingestCodeGraph(db, { projectId, rootDir: root, incremental, sqlLineageOverride: false });

    const rows = (projectId: string) =>
      db.codeSymbol.findMany({
        where: { projectId },
        include: { embedding: true },
        orderBy: [{ startLine: "asc" }, { kind: "asc" }],
      });

    /** Everything stored from the file's text, as one string. */
    const storedText = async (projectId: string): Promise<string> =>
      JSON.stringify(
        (await rows(projectId)).map((r) => [r.signature, r.docComment, r.embedding?.text]),
      );

    it("a full ingest stores no secret, and every span is the clean file's", async () => {
      const { projectId, root } = await newProject(TREE);
      await ingest(projectId, root, false);
      const text = await storedText(projectId);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(DB_URL_PASSWORD);

      const connect = (await rows(projectId)).find((r) => r.name === "connect")!;
      expect(connect.docComment).toBe("Calls the API with [REDACTED:github_pat] as the bearer.");
      expect(connect.signature).toBe(
        'export function connect(url = "postgres://[REDACTED:url_credentials]@db:5432/app"): string',
      );
      expect(connect.embedding?.text).toContain('  const auth = "[REDACTED:github_pat]";');

      const clean = await newProject(CLEAN_TREE);
      await ingest(clean.projectId, clean.root, false);
      const spans = async (id: string) =>
        (await rows(id)).map((r) => [r.kind, r.name, r.startLine, r.endLine]);
      expect(await spans(projectId)).toEqual(await spans(clean.projectId));
    });

    it("an older graph has its stored secrets replaced on the next incremental ingest", async () => {
      const { projectId, root } = await newProject(TREE);
      await ingest(projectId, root, false);

      // Put the graph back to how a pre-#2333 ingest left it: the secrets in
      // the stored text, every symbol embedded, the previous version recorded.
      const connect = (await rows(projectId)).find((r) => r.name === "connect")!;
      const leakedText = connect.embedding!.text.replace(/\[REDACTED:github_pat\]/g, TOKEN);
      await db.codeSymbol.update({
        where: { id: connect.id },
        data: { docComment: `Calls the API with ${TOKEN} as the bearer.` },
      });
      await db.codeSymbolEmbedding.update({
        where: { symbolId: connect.id },
        data: { text: leakedText, contentHash: sha256(leakedText) },
      });
      await db.codeSymbolEmbedding.updateMany({
        where: { projectId },
        data: { embeddingModel: "fixture-model" },
      });
      await db.codeGraph.updateMany({
        where: { projectId },
        // 2: the version every graph written before #2333 carries.
        data: { symbolContextVersion: 2 },
      });
      expect(await storedText(projectId)).toContain(TOKEN);

      await ingest(projectId, root, true);

      expect(await storedText(projectId)).not.toContain(TOKEN);
      const after = (await rows(projectId)).find((r) => r.name === "connect")!;
      // In place: the same row, and its text queued to be embedded again.
      expect(after.id).toBe(connect.id);
      expect(after.embedding?.embeddingModel).toBe("");
      expect(after.embedding?.contentHash).toBe(sha256(after.embedding!.text));
      // A symbol whose text did not change is not re-embedded.
      const plain = (await rows(projectId)).find((r) => r.name === "plain")!;
      expect(plain.embedding?.embeddingModel).toBe("fixture-model");
      expect(
        (await db.codeGraph.findFirstOrThrow({ where: { projectId } })).symbolContextVersion,
      ).toBe(SYMBOL_CONTEXT_VERSION);
    });
  },
);
