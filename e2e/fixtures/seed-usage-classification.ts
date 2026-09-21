/**
 * Fixture helper for seeding the usage-classification scenario — Epic #292 (#298).
 *
 * Shells out to `server/scripts/e2e-seed-usage-classification.ts` running
 * against the e2e SQLite database (same pattern as `seed-drift.ts` /
 * `seed-helpers.ts`) so the Prisma client resolves from the server workspace.
 *
 * Why a DB seed rather than the real compute route: the per-object
 * used/unreferenced/uncertain classification is produced by introspecting a
 * live DB connector and reconciling it against the code→schema graph
 * (#296/#297). That path needs a real database connector, which the offline
 * e2e stack has no deterministic way to provide. Seeding the persisted rows
 * lets the spec drive the real `GET .../usage-classification` route and the
 * real UI rendering while keeping the data deterministic.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.resolve(REPO_ROOT, "server", "scripts", "e2e-seed-usage-classification.ts");

export interface SeedUsageClassificationOpts {
  projectId: string;
  databaseUrl: string;
}

export interface SeedUsageClassificationResult {
  analysisId: string;
  projectId: string;
  used: number;
  unreferenced: number;
  uncertain: number;
}

/**
 * Seed an ImpactAnalysis (with one item for the project) plus a deterministic
 * set of SchemaUsageClassification rows (2 used, 1 unreferenced, 1 uncertain).
 * Returns the analysis id so the spec can navigate to `/impact-analyses/:id`.
 */
export function seedUsageClassificationViaCli(
  opts: SeedUsageClassificationOpts,
): SeedUsageClassificationResult {
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
      `e2e-seed-usage-classification.ts failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as SeedUsageClassificationResult;
  if (!parsed.analysisId) {
    throw new Error(
      `e2e-seed-usage-classification.ts returned malformed payload: ${result.stdout}`,
    );
  }
  return parsed;
}
