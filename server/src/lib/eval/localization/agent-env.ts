/**
 * #1755 — the environment an agent arm (A3, A3A, A3N) runs in. Its tools read
 * the MATERIALIZED corpus (#1799): the eval database, the clones and the symbol
 * vectors under `eval-data/.materialized/`. Prisma binds its database when it is
 * first imported, so the CLI binds these variables before anything that imports
 * it (`scripts/eval-localization-env.ts`, imported first). This module imports
 * nothing that loads Prisma.
 */
import type { MaterializeLayout } from "./materialize.js";

/** The agent arms; `agent-arms.ts` holds their definitions (and a test pins the two lists). */
export const AGENT_ARMS = ["A3", "A3A", "A3N"] as const;

/** True when `--arms` names an agent arm (the same parsing as `parseArmIds`). */
export function agentArmsRequested(argv: readonly string[]): boolean {
  const i = argv.indexOf("--arms");
  if (i < 0) return false;
  const ids = (argv[i + 1] ?? "").split(",").map((s) => s.trim().toUpperCase());
  return ids.some((id) => (AGENT_ARMS as readonly string[]).includes(id));
}

/** Point the database, the clones and the vectors at the materialized layout. */
export function bindMaterializedEnv(env: NodeJS.ProcessEnv, layout: MaterializeLayout): void {
  env.DATABASE_URL = layout.databaseUrl;
  env.REPO_CLONE_DIR = layout.cloneRoot;
  env.LANCEDB_PATH = layout.lancedbPath;
}
