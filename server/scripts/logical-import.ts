/* eslint-disable no-console */
/**
 * METIS logical import (Path B portability) — load a provider-agnostic NDJSON
 * dump produced by logical-export.ts into a FRESH target database.
 *
 * Preconditions (the operator must satisfy these BEFORE running):
 *   - The target schema already exists: run `prisma migrate deploy` against the
 *     target DATABASE_URL first. This script does NOT create the schema.
 *   - The target tables MUST be empty (a fresh DB). The load uses `createMany`
 *     WITHOUT `skipDuplicates`, so re-running against a non-empty target throws
 *     on the first primary-key collision. This is NOT idempotent: it is a
 *     fresh-target load, and the final row-count verification compares against
 *     the manifest, so a partially-populated target would be flagged as a
 *     mismatch rather than silently merged.
 *
 * Load strategy:
 *   - Rows are inserted in the FK-safe `loadOrder` from the manifest (referenced
 *     models before referencing models).
 *   - Cycle / self-reference FK columns recorded in `deferredFks` are NULLED on
 *     the first insert, then a second UPDATE pass restores them from the dump.
 *   - We do NOT wrap the whole load in one interactive transaction: a 132-table,
 *     potentially large dataset exceeds Prisma's interactive-transaction time
 *     budget and risks SQLite "database is locked". Instead each model load and
 *     the deferred-FK fix-up run as their own batched operations. The import is
 *     NOT idempotent — it requires an EMPTY target (see Preconditions): a re-run
 *     against a populated DB throws on a PK collision (`createMany` is used
 *     without `skipDuplicates`). It verifies per-model row counts against the
 *     manifest at the end, failing LOUDLY (non-zero exit) on any mismatch.
 *   - The optional `--remap <file.json>` applies env-specific connector/config
 *     rewrites AFTER load, inside a transaction (see connector-remap.ts).
 *
 * Usage:
 *   tsx scripts/logical-import.ts <inDir> [--remap <file.json>] [--help]
 *
 * Exit codes: 0 ok · 1 error (incl. count mismatch) · 2 usage error
 */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { parsePrismaSchema, type ScalarFieldInfo } from "../src/lib/portability/schema-fk-graph.js";
import {
  createLogicalAdapter,
  requireDatabaseUrl,
  resolveLogicalProvider,
} from "../src/lib/portability/logical-adapter.js";
import {
  deserializeRow,
  parseLogicalManifest,
  type DeferredFk,
  type FieldTypeMap,
  type LogicalManifest,
} from "../src/lib/portability/logical-dump.js";
import {
  computeRemap,
  parseRemapSpec,
  type RemapRow,
} from "../src/lib/portability/connector-remap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");
const SCHEMA_PATH = path.join(SERVER_ROOT, "prisma", "schema.prisma");

const log = (m: string) => console.log(`[logical-import] ${m}`);
const die = (m: string, code = 1): never => {
  console.error(`[logical-import] ERROR: ${m}`);
  process.exit(code);
};

const BATCH = 500;

function printHelp(): void {
  console.log(`
Usage: tsx scripts/logical-import.ts <inDir> [--remap <file.json>] [--help]

  <inDir>            Required. Directory containing <Model>.ndjson + logical-manifest.json.
  --remap <file>     Optional. JSON remap spec for env-specific connector/config rewrites
                     applied AFTER load, inside a transaction. See docs/DATA_PORTABILITY.md.

Preconditions: target schema already created (prisma migrate deploy) and target
tables empty. Loads in FK-safe order; nulls deferred (cyclic) FKs then UPDATEs
them in a second pass; verifies per-model row counts vs the manifest.

Exit codes: 0 ok · 1 error (incl. count mismatch) · 2 usage error
`);
}

function fieldTypeMap(fields: ScalarFieldInfo[]): FieldTypeMap {
  const m: FieldTypeMap = {};
  for (const f of fields) m[f.name] = f.type;
  return m;
}

/**
 * Build a Prisma `where` unique selector from a model's primary key + a row.
 * Single-column PK → `{ id: value }`. Composite PK → the Prisma compound key
 * shape `{ "<a>_<b>": { a, b } }` (the default unprefixed name for `@@id`).
 */
function whereForPk(pk: string[], row: Record<string, unknown>): Record<string, unknown> {
  if (pk.length === 1) return { [pk[0]]: row[pk[0]] };
  const compoundKey = pk.join("_");
  const inner: Record<string, unknown> = {};
  for (const col of pk) inner[col] = row[col];
  return { [compoundKey]: inner };
}

interface WriteDelegate {
  createMany(args: { data: Record<string, unknown>[] }): Promise<{ count: number }>;
  count(): Promise<number>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
}

function delegateFor(prisma: PrismaClient, modelName: string): WriteDelegate | null {
  const key = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  const delegate = (prisma as unknown as Record<string, unknown>)[key];
  if (delegate && typeof (delegate as { createMany?: unknown }).createMany === "function") {
    return delegate as WriteDelegate;
  }
  return null;
}

/** Read every line of an NDJSON file as a parsed object (streaming). */
async function* readNdjson(file: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    yield JSON.parse(trimmed) as Record<string, unknown>;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  let remapFile: string | null = null;
  const remapIdx = args.indexOf("--remap");
  if (remapIdx !== -1) {
    remapFile = args[remapIdx + 1] ?? null;
    if (!remapFile || remapFile.startsWith("--")) die("--remap requires a file path", 2);
  }

  const positionals = args.filter(
    (a, i) => !a.startsWith("--") && a !== "-h" && !(remapIdx !== -1 && i === remapIdx + 1),
  );
  const inDir = positionals[0];
  if (!inDir) die("missing required <inDir> argument", 2);

  const resolvedIn = path.resolve(inDir);
  const manifestPath = path.join(resolvedIn, "logical-manifest.json");
  if (!existsSync(manifestPath)) {
    die(`logical-manifest.json not found in ${resolvedIn}`, 2);
  }

  let manifest: LogicalManifest;
  try {
    manifest = parseLogicalManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch (err) {
    return void die(`invalid manifest: ${err instanceof Error ? err.message : String(err)}`, 1);
  }

  // Validate the remap spec BEFORE touching the DB (fail fast on bad spec).
  let remapSpec: ReturnType<typeof parseRemapSpec> | null = null;
  if (remapFile) {
    const resolvedRemap = path.resolve(remapFile);
    if (!existsSync(resolvedRemap)) die(`--remap file not found: ${resolvedRemap}`, 2);
    try {
      remapSpec = parseRemapSpec(JSON.parse(readFileSync(resolvedRemap, "utf8")));
    } catch (err) {
      return void die(`invalid remap spec: ${err instanceof Error ? err.message : String(err)}`, 2);
    }
    log(`remap spec validated: ${resolvedRemap}`);
  }

  const schemaModels = parsePrismaSchema(readFileSync(SCHEMA_PATH, "utf8"));
  const byName = new Map(schemaModels.map((m) => [m.name, m]));

  // deferred FK columns per model (set to null on insert, UPDATE in pass 2).
  const deferredByModel = new Map<string, DeferredFk[]>();
  for (const d of manifest.deferredFks) {
    const list = deferredByModel.get(d.model) ?? [];
    list.push(d);
    deferredByModel.set(d.model, list);
  }

  // Fail fast if DATABASE_URL is unset — an import MUTATES its target DB, so we
  // must never silently fall back to a default dev database.
  let dbUrl: string;
  try {
    dbUrl = requireDatabaseUrl();
  } catch (err) {
    return void die(err instanceof Error ? err.message : String(err), 2);
  }
  const provider = resolveLogicalProvider(process.env.DATABASE_PROVIDER);

  let prisma: PrismaClient;
  try {
    prisma = new PrismaClient({
      adapter: await createLogicalAdapter(
        provider,
        dbUrl,
        (url) => new PrismaBetterSqlite3({ url }),
      ),
    });
  } catch (err) {
    // Postgres adapter absent (or other adapter-construction failure) — fail loud.
    return void die(err instanceof Error ? err.message : String(err), 1);
  }
  try {
    log(`input dir : ${resolvedIn}`);
    log(`manifest  : provider=${manifest.provider} schemaVersion=${manifest.schemaVersion}`);
    log(`models    : ${manifest.loadOrder.length}  (deferred FKs: ${manifest.deferredFks.length})`);

    // ── Pass 1: load rows in FK-safe order, nulling deferred FK columns ──────
    for (const modelName of manifest.loadOrder) {
      const file = path.join(resolvedIn, `${modelName}.ndjson`);
      if (!existsSync(file)) {
        // Missing file but manifest claims 0 rows is fine; otherwise fail.
        if ((manifest.rowCounts[modelName] ?? 0) === 0) continue;
        die(`expected NDJSON file missing for ${modelName}: ${file}`, 1);
      }
      const info = byName.get(modelName);
      if (!info) die(`schema has no model named "${modelName}" (manifest/schema drift)`, 1);
      const types = fieldTypeMap(info!.scalarFields);
      const deferredCols = new Set(
        (deferredByModel.get(modelName) ?? []).flatMap((d) => d.columns),
      );

      const delegate = delegateFor(prisma, modelName);
      if (!delegate) die(`no Prisma delegate for model "${modelName}"`, 1);

      let batch: Record<string, unknown>[] = [];
      let loaded = 0;

      const flush = async () => {
        if (batch.length === 0) return;
        await delegate!.createMany({ data: batch });
        loaded += batch.length;
        batch = [];
      };

      for await (const raw of readNdjson(file)) {
        const row = deserializeRow(raw, types);
        // Null deferred FK columns on first insert (restored in pass 2).
        for (const col of deferredCols) row[col] = null;
        batch.push(row);
        if (batch.length >= BATCH) await flush();
      }
      await flush();
      if (loaded > 0) log(`  loaded ${modelName}: ${loaded} rows`);
    }

    // ── Pass 2: restore deferred FK columns via UPDATE ──────────────────────
    let deferredUpdates = 0;
    for (const [modelName, defs] of deferredByModel) {
      const file = path.join(resolvedIn, `${modelName}.ndjson`);
      if (!existsSync(file)) {
        // Mirror Pass-1: a missing file is fine ONLY if the manifest expects 0
        // rows; otherwise the dump is incomplete and we must fail loudly rather
        // than silently skip restoring this model's deferred FK columns.
        if ((manifest.rowCounts[modelName] ?? 0) === 0) continue;
        die(`expected NDJSON file missing for deferred-FK model ${modelName}: ${file}`, 1);
      }
      const info = byName.get(modelName)!;
      const types = fieldTypeMap(info.scalarFields);
      const pk = info.primaryKey;
      const cols = [...new Set(defs.flatMap((d) => d.columns))];
      const delegate = delegateFor(prisma, modelName)!;

      for await (const raw of readNdjson(file)) {
        const row = deserializeRow(raw, types);
        const data: Record<string, unknown> = {};
        let hasValue = false;
        for (const c of cols) {
          if (row[c] !== null && row[c] !== undefined) {
            data[c] = row[c];
            hasValue = true;
          }
        }
        if (!hasValue) continue;
        await delegate.update({ where: whereForPk(pk, row), data });
        deferredUpdates++;
      }
    }
    if (deferredUpdates > 0) log(`restored ${deferredUpdates} deferred FK value(s) in pass 2`);

    // ── Verify per-model row counts vs manifest (fail loudly) ───────────────
    const mismatches: string[] = [];
    for (const modelName of manifest.includedModels) {
      const expected = manifest.rowCounts[modelName] ?? 0;
      const delegate = delegateFor(prisma, modelName);
      if (!delegate) {
        // An unresolved delegate for a model the manifest claims to include is a
        // hard failure: we cannot verify its rows, which defeats fail-loud. (A
        // model with 0 expected rows AND no delegate is still suspicious — the
        // model is in the manifest's includedModels, so its delegate must exist.)
        die(
          `no Prisma delegate for included model "${modelName}" — cannot verify ` +
            `its ${expected} expected row(s) (manifest/schema drift)`,
          1,
        );
      }
      const actual: number = await delegate.count();
      if (actual !== expected) mismatches.push(`${modelName}: expected ${expected}, got ${actual}`);
    }
    if (mismatches.length > 0) {
      die(`row-count verification FAILED:\n  ${mismatches.join("\n  ")}`, 1);
    }
    log(`row-count verification PASSED for ${manifest.includedModels.length} models`);

    // ── Optional connector/env remap (inside a transaction) ─────────────────
    if (remapSpec) {
      await applyRemap(prisma, remapSpec);
    } else {
      printFixupChecklist();
    }

    log(`=== IMPORT COMPLETE ===`);
  } finally {
    await prisma.$disconnect();
  }
}

/** Minimal delegate surfaces used by the remap apply path. */
interface FindManyDelegate {
  findMany(args: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}
interface UpdateDelegate {
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
}
interface UpsertDelegate {
  upsert(args: {
    where: Record<string, unknown>;
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  }): Promise<unknown>;
}

function client(obj: object, key: string): Record<string, unknown> {
  return (obj as unknown as Record<string, unknown>)[key] as Record<string, unknown>;
}

async function applyRemap(
  prisma: PrismaClient,
  spec: ReturnType<typeof parseRemapSpec>,
): Promise<void> {
  // Prisma lowercases only the first character of the model name to form the
  // delegate key (so MCPServer → mCPServer).
  const delegateKeyFor = (model: string) =>
    model === "MCPServer" ? "mCPServer" : model.charAt(0).toLowerCase() + model.slice(1);

  // Gather current rows for the remappable models + current RuntimeConfig values.
  const repo = (await (client(prisma, "repoConnection") as unknown as FindManyDelegate).findMany({
    select: { id: true, apiBaseUrl: true, localPath: true, uploadPath: true },
  })) as RemapRow[];
  const db = (await (client(prisma, "databaseConnection") as unknown as FindManyDelegate).findMany({
    select: { id: true, host: true, port: true, databaseName: true },
  })) as RemapRow[];
  const mcp = (await (client(prisma, "mCPServer") as unknown as FindManyDelegate).findMany({
    select: { id: true, url: true },
  })) as RemapRow[];

  const rcKeys = spec.RuntimeConfig?.set ? Object.keys(spec.RuntimeConfig.set) : [];
  const rcValues: Record<string, string | null> = {};
  if (rcKeys.length > 0) {
    const rows = (await (client(prisma, "runtimeConfig") as unknown as FindManyDelegate).findMany({
      where: { key: { in: rcKeys } },
      select: { key: true, value: true },
    })) as unknown as { key: string; value: string | null }[];
    for (const r of rows) rcValues[r.key] = r.value;
  }

  const plan = computeRemap(spec, {
    RepoConnection: repo,
    DatabaseConnection: db,
    MCPServer: mcp,
    runtimeConfigValues: rcValues,
  });

  await prisma.$transaction(async (tx) => {
    for (const result of plan.models) {
      const delegate = client(tx, delegateKeyFor(result.model)) as unknown as UpdateDelegate;
      // Group changes by row id to issue one update per row.
      const byRow = new Map<string, Record<string, unknown>>();
      for (const c of result.changes) {
        const d = byRow.get(c.rowId) ?? {};
        d[c.field] = c.after;
        byRow.set(c.rowId, d);
      }
      for (const [id, data] of byRow) {
        await delegate.update({ where: { id }, data });
      }
    }
    for (const c of plan.runtimeConfig) {
      // Upsert by key (key is the unique identifier of RuntimeConfig).
      await (client(tx, "runtimeConfig") as unknown as UpsertDelegate).upsert({
        where: { key: c.key },
        update: { value: c.after },
        create: { key: c.key, value: c.after, valueType: "string", scope: "global" },
      });
    }
  });

  // Report counts only (never log secret values — these models hold none).
  log("=== REMAP APPLIED ===");
  for (const result of plan.models) {
    log(`  ${result.model}: ${result.changes.length} field change(s)`);
  }
  log(`  RuntimeConfig: ${plan.runtimeConfig.length} key change(s)`);
}

function printFixupChecklist(): void {
  console.log("");
  console.log("=== POST-IMPORT FIX-UP CHECKLIST (no --remap supplied) ===");
  console.log("Review and override env-specific values for THIS host:");
  console.log("  RepoConnection:     apiBaseUrl, localPath, uploadPath   (all --remap-able)");
  console.log("  DatabaseConnection: host, port, databaseName            (all --remap-able)");
  console.log(
    "  MCPServer:          url (--remap-able); command, runtime (manual DB/UI edit only)",
  );
  console.log("  RuntimeConfig:      env-specific-tunable keys (see env-config-classifier)");
  console.log("Or re-run with --remap <file.json> to apply the --remap-able fields automatically.");
  console.log(
    "(MCPServer.command / MCPServer.runtime are NOT --remap-able — edit them in the DB/UI.)",
  );
  console.log("See docs/DATA_PORTABILITY.md for the full runbook.");
  console.log("");
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
