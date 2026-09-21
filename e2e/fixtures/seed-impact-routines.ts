/**
 * Fixture helper for seeding the impact-analysis "procedures & functions"
 * scenario — Epic #293 Phase 2 (#302).
 *
 * Shells out to `server/scripts/e2e-seed-impact-routines.ts` against the e2e
 * SQLite database (same pattern as `seed-usage-classification.ts`) so the Prisma
 * client resolves from the server workspace.
 *
 * Why a DB seed rather than the real compute route: the affected routines and
 * their used/unreferenced/uncertain classification are produced by introspecting
 * a live DB connector and reconciling it against the code→schema graph — a path
 * the offline e2e stack cannot reproduce deterministically. Seeding the
 * persisted rows lets the spec drive the real read route + real UI rendering
 * while keeping the data deterministic.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.resolve(REPO_ROOT, "server", "scripts", "e2e-seed-impact-routines.ts");

export interface SeedImpactRoutinesOpts {
  projectId: string;
  databaseUrl: string;
}

export interface SeedImpactRoutinesResult {
  analysisId: string;
  projectId: string;
  classification: { table: number; procedureUsed: number; functionUncertain: number };
  affected: { tables: number; procedures: number; functions: number };
}

/**
 * Seed an ImpactAnalysis (with one item whose `affectedTables` include a table,
 * a procedure and a function) plus matching `SchemaUsageClassification` rows
 * (table=used, procedure=used, function=uncertain). Returns the analysis id so
 * the spec can navigate to `/impact-analyses/:id`.
 */
export function seedImpactRoutinesViaCli(opts: SeedImpactRoutinesOpts): SeedImpactRoutinesResult {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@metis/server", "exec", "tsx", SCRIPT, opts.projectId],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: opts.databaseUrl,
        DATABASE_PROVIDER: "sqlite",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `e2e-seed-impact-routines.ts failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as SeedImpactRoutinesResult;
  if (!parsed.analysisId) {
    throw new Error(`e2e-seed-impact-routines.ts returned malformed payload: ${result.stdout}`);
  }
  return parsed;
}
