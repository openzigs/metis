/* eslint-disable no-console */
/**
 * METIS logical export (Path B portability) — provider-agnostic NDJSON dump.
 *
 * Reads every INCLUDED model from the live database via the Prisma client and
 * writes one `<ModelName>.ndjson` file per model plus a `logical-manifest.json`
 * into an output directory. Unlike the physical backup (scripts/backup.sh), the
 * dump FORMAT is provider-neutral: the SQLite and Postgres schemas are
 * semantically identical (same 132 models/fields; only the datasource provider
 * differs; no `@db.*` native types), so the NDJSON transfers 1:1 between
 * providers. SQLite→SQLite reload is exercised in CI; the SQLite→Postgres
 * direction is wired (provider-aware adapter, see logical-adapter.ts) but opt-in
 * and not yet exercised in CI (requires `@prisma/adapter-pg` in the target env).
 *
 * Rows are paged with a cursor (`findMany` + `take`/`cursor`) so large tables
 * are never loaded into memory all at once. Values are serialized losslessly by
 * Prisma scalar type (see logical-dump.ts: DateTime→ISO, Json verbatim,
 * Bytes→base64, BigInt/Decimal→string).
 *
 * Usage:
 *   tsx scripts/logical-export.ts <outDir> [--help]
 *
 * Environment:
 *   DATABASE_URL        Prisma connection string (the source DB). REQUIRED — the
 *                       CLI does NOT fall back to a default dev database.
 *   DATABASE_PROVIDER   sqlite | postgresql | postgres (default: sqlite). Selects
 *                       the Prisma driver adapter AND labels the manifest. For
 *                       `postgresql` the adapter (`@prisma/adapter-pg`) is loaded
 *                       by dynamic import and is NOT a committed dependency; if it
 *                       is absent the CLI fails loudly with an actionable message.
 *
 * Exit codes: 0 ok · 1 error · 2 usage error
 */

import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  assertParserCoversDmmfRelations,
  parsePrismaSchema,
  type ScalarFieldInfo,
} from "../src/lib/portability/schema-fk-graph.js";
import {
  createLogicalAdapter,
  requireDatabaseUrl,
  resolveLogicalProvider,
} from "../src/lib/portability/logical-adapter.js";
import {
  buildLogicalManifest,
  isModelExcluded,
  orderModelsForLoad,
  serializeRow,
  stripExcludedFields,
  type FieldTypeMap,
} from "../src/lib/portability/logical-dump.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SERVER_ROOT, "..");
const SCHEMA_PATH = path.join(SERVER_ROOT, "prisma", "schema.prisma");

const log = (m: string) => console.log(`[logical-export] ${m}`);
const die = (m: string, code = 1): never => {
  console.error(`[logical-export] ERROR: ${m}`);
  process.exit(code);
};

const PAGE_SIZE = 1000;

function printHelp(): void {
  console.log(`
Usage: tsx scripts/logical-export.ts <outDir> [--help]

  <outDir>   Required. Directory to write <Model>.ndjson files + logical-manifest.json.

Environment:
  DATABASE_URL        Prisma connection string (source DB).
  DATABASE_PROVIDER   sqlite | postgresql | postgres (default sqlite) — manifest label only.

Writes one NDJSON file per model plus logical-manifest.json (row counts, schema
version, FK load order, deferred FKs, included/excluded registry).

Exit codes: 0 ok · 1 error · 2 usage error
`);
}

/** Map a model's scalar fields to a FieldTypeMap for the serializer. */
function fieldTypeMap(fields: ScalarFieldInfo[]): FieldTypeMap {
  const m: FieldTypeMap = {};
  for (const f of fields) m[f.name] = f.type;
  return m;
}

type FindManyArgs = {
  take?: number;
  skip?: number;
  cursor?: Record<string, unknown>;
  orderBy?: Record<string, "asc" | "desc">[];
};
interface ReadDelegate {
  findMany(args: FindManyArgs): Promise<Record<string, unknown>[]>;
}

/** Resolve the Prisma delegate (e.g. prisma.workspace) for a PascalCase model. */
function delegateFor(prisma: PrismaClient, modelName: string): ReadDelegate | null {
  const key = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  const delegate = (prisma as unknown as Record<string, unknown>)[key];
  if (delegate && typeof (delegate as { findMany?: unknown }).findMany === "function") {
    return delegate as ReadDelegate;
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const positionals = args.filter((a) => !a.startsWith("--") && a !== "-h");
  const outDir = positionals[0];
  if (!outDir) {
    die("missing required <outDir> argument", 2);
  }
  const resolvedOut = path.resolve(outDir);
  mkdirSync(resolvedOut, { recursive: true });

  const provider = resolveLogicalProvider(process.env.DATABASE_PROVIDER);
  // Fail fast if DATABASE_URL is unset — never silently target a default dev DB.
  let dbUrl: string;
  try {
    dbUrl = requireDatabaseUrl();
  } catch (err) {
    return void die(err instanceof Error ? err.message : String(err), 2);
  }

  // Read schema version from the ROOT package.json (app/schema version).
  let schemaVersion = "0.0.0";
  try {
    schemaVersion = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
  } catch {
    /* keep default */
  }

  // FK info + deterministic load order from the schema text (authoritative).
  const schemaModels = parsePrismaSchema(readFileSync(SCHEMA_PATH, "utf8"));

  // Loud guard: every relation the runtime DMMF knows about must be accounted
  // for by the parser (owning edge or recognized inverse). A relation syntax the
  // parser cannot model would otherwise corrupt the FK load order silently.
  try {
    assertParserCoversDmmfRelations(schemaModels, Prisma.dmmf.datamodel.models);
  } catch (err) {
    return void die(err instanceof Error ? err.message : String(err), 1);
  }

  const { order, deferred } = orderModelsForLoad(schemaModels);
  const byName = new Map(schemaModels.map((m) => [m.name, m]));

  // Cross-check against the runtime DMMF: every model must be present in both.
  const dmmfNames = new Set(Prisma.dmmf.datamodel.models.map((m) => m.name));

  const prisma = new PrismaClient({
    adapter: await createLogicalAdapter(provider, dbUrl, (url) => new PrismaBetterSqlite3({ url })),
  });
  const rowCounts: Record<string, number> = {};
  const includedModels: string[] = [];

  try {
    log(`output dir : ${resolvedOut}`);
    log(`provider   : ${provider}  schemaVersion: ${schemaVersion}`);
    log(`models     : ${order.length}  (deferred FKs: ${deferred.length})`);

    for (const modelName of order) {
      if (isModelExcluded(modelName)) {
        log(`SKIP (excluded model): ${modelName}`);
        continue;
      }
      if (!dmmfNames.has(modelName)) {
        die(`model "${modelName}" parsed from schema is absent from the runtime DMMF`, 1);
      }
      const info = byName.get(modelName)!;
      const types = fieldTypeMap(info.scalarFields);
      const pk = info.primaryKey;
      // Keyset (cursor) pagination requires a single-column PK; composite-PK
      // join tables (6 of 132) use offset pagination — they are small.
      const singleId = pk.length === 1 ? pk[0] : null;
      const orderBy = pk.map((col) => ({ [col]: "asc" as const }));

      const delegate = delegateFor(prisma, modelName);
      if (!delegate) {
        die(`no Prisma delegate found for model "${modelName}"`, 1);
      }

      const filePath = path.join(resolvedOut, `${modelName}.ndjson`);
      const stream = createWriteStream(filePath, { encoding: "utf8" });
      let count = 0;
      let cursor: Record<string, unknown> | undefined;
      let offset = 0;

      // Pagination keeps memory bounded regardless of table size.
      for (;;) {
        const page = await delegate.findMany({
          take: PAGE_SIZE,
          orderBy,
          ...(singleId ? (cursor ? { cursor, skip: 1 } : {}) : { skip: offset }),
        });
        if (page.length === 0) break;

        for (const row of page) {
          const stripped = stripExcludedFields(modelName, row);
          const serialized = serializeRow(stripped, types);
          stream.write(JSON.stringify(serialized) + "\n");
          count++;
        }
        if (singleId) {
          cursor = { [singleId]: page[page.length - 1][singleId] };
        } else {
          offset += page.length;
        }
        if (page.length < PAGE_SIZE) break;
      }

      await new Promise<void>((resolve, reject) => {
        stream.end((err: unknown) => (err ? reject(err) : resolve()));
      });

      rowCounts[modelName] = count;
      includedModels.push(modelName);
      if (count > 0) log(`  ${modelName}: ${count} rows`);
    }

    const manifest = buildLogicalManifest({
      provider,
      schemaVersion,
      rowCounts,
      includedModels,
      loadOrder: order.filter((m) => !isModelExcluded(m)),
      deferredFks: deferred,
    });
    writeFileSync(
      path.join(resolvedOut, "logical-manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );

    const total = Object.values(rowCounts).reduce((a, b) => a + b, 0);
    log(`=== EXPORT COMPLETE === ${includedModels.length} models, ${total} rows total`);
    log(`manifest: ${path.join(resolvedOut, "logical-manifest.json")}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
