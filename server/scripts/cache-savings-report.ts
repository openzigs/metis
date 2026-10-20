/**
 * #1277 — read-only prompt-cache savings report over the `token_usages` ledger:
 * per `agentStep` × model, the cache read and write tokens and the net saving
 * in USD (uncached cost minus actual cost with the write surcharge). See
 * `src/lib/finops/cache-savings-report.ts` for the arithmetic. Spends nothing
 * and writes nothing: SQLite is opened with `readOnly: true`; for Postgres the
 * query is printed instead.
 *
 *   pnpm cache:report -- --db dev.db
 *   pnpm cache:report -- --db dev.db --since 2026-10-15T13:44 --ttl 5m --json
 *   pnpm cache:report -- --sql            # the aggregate query, for Postgres
 *
 * `--db` is resolved from the server package directory. Prices come from the
 * built-in list plus `MODEL_PRICES` — the database's `runtime_config` row when
 * there is one, else the environment (`.env`).
 */
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigService } from "../src/lib/config/config-service.js";
import {
  CACHE_SAVINGS_SQL,
  formatCacheSavingsTable,
  ledgerRowsQuery,
  summarizeCacheSavings,
  type LedgerCacheRow,
} from "../src/lib/finops/cache-savings-report.js";

function main(): void {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      ttl: { type: "string", default: "5m" },
      json: { type: "boolean", default: false },
      sql: { type: "boolean", default: false },
    },
  });
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (values.sql || (!values.db && /^postgres(ql)?:/i.test(databaseUrl))) {
    process.stdout.write(`${CACHE_SAVINGS_SQL}\n`);
    return;
  }
  if (!values.db) throw new Error("--db <sqlite file> is required (or --sql for Postgres)");
  if (values.ttl !== "5m" && values.ttl !== "1h") throw new Error("--ttl must be 5m or 1h");

  const db = new DatabaseSync(resolve(values.db), { readOnly: true });
  try {
    const { sql, params } = ledgerRowsQuery({
      ...(values.since ? { since: values.since } : {}),
      ...(values.until ? { until: values.until } : {}),
    });
    const rows = db.prepare(sql).all(...params) as unknown as LedgerCacheRow[];
    const stored = db
      .prepare(`SELECT value FROM runtime_config WHERE key = 'MODEL_PRICES'`)
      .get() as { value?: string } | undefined;
    const env: Record<string, string> = {};
    const prices = stored?.value ?? process.env.MODEL_PRICES;
    if (prices) env.MODEL_PRICES = prices;
    const lines = summarizeCacheSavings(rows, {
      config: new ConfigService({ env, vault: {} as never }),
      ttl: values.ttl,
    });
    process.stdout.write(
      `${values.json ? JSON.stringify(lines, null, 2) : formatCacheSavingsTable(lines)}\n`,
    );
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err: unknown) {
  process.stderr.write(`report failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
