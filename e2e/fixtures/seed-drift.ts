/**
 * Helpers for seeding DriftEvent rows directly in the e2e database.
 *
 * Uses the same pattern as `seed-helpers.ts` — shells out to a tsx script
 * running against the e2e SQLite database so the Prisma client resolves
 * correctly.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.resolve(REPO_ROOT, "server", "scripts", "e2e-seed-drift.ts");

export interface SeedDriftOpts {
  projectId: string;
  databaseUrl: string;
  field?: string;
  localValue?: string;
  externalValue?: string;
}

export interface SeedDriftResult {
  driftId: string;
  publishedIssueId: string;
  projectId: string;
  /**
   * `PublishedIssue.issueId` — what `reconcileIssueChange` matches an inbound
   * webhook's external issue id against (GitHub `issue.node_id`, Jira
   * `issue.id`). A spec that wants the real `drift:detected` broadcast has to
   * post a webhook carrying this id; a direct row insert emits nothing (#78).
   */
  externalIssueId: string;
  issueNumber: number;
  /** The IssueDraft title/body the reconciler diffs an inbound webhook against. */
  draftTitle: string;
  draftBody: string;
}

/**
 * Insert a DriftEvent row (with supporting PublishBatch, IssueDraft, and
 * PublishedIssue rows) directly into the e2e database.
 */
export function seedDriftViaCli(opts: SeedDriftOpts): SeedDriftResult {
  const args = [
    "--filter",
    "@metis/server",
    "exec",
    "tsx",
    SCRIPT,
    opts.projectId,
    opts.field ?? "title",
    opts.localValue ?? "Original METIS title",
    opts.externalValue ?? "Edited title in GitHub",
  ];

  const result = spawnSync("pnpm", args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: opts.databaseUrl,
      DATABASE_PROVIDER: "sqlite",
    },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `e2e-seed-drift.ts failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }

  const parsed = JSON.parse(result.stdout) as SeedDriftResult;
  if (!parsed.driftId || !parsed.externalIssueId) {
    throw new Error(`e2e-seed-drift.ts returned malformed payload: ${result.stdout}`);
  }
  return parsed;
}
