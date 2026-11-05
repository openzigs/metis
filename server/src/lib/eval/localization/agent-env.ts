/**
 * #1755 — the environment an agent arm (A3, A3A, A3N) runs in, and #1818 an
 * analysis arm (A7, A7O). Its tools read
 * the MATERIALIZED corpus (#1799): the eval database, the clones and the symbol
 * vectors under `eval-data/.materialized/`. Prisma binds its database when it is
 * first imported, so the CLI binds these variables before anything that imports
 * it (`scripts/eval-localization-env.ts`, imported first). This module imports
 * nothing that loads Prisma.
 */
import type { MaterializeLayout } from "./materialize.js";

/** The agent arms; `agent-arms.ts` holds their definitions (and a test pins the two lists). */
export const AGENT_ARMS = ["A3", "A3A", "A3N"] as const;

/** #1818 — the analysis arms; `analysis-arms.ts` holds their definitions (a test pins them too). */
export const ANALYSIS_ARMS = ["A7", "A7O"] as const;

/** True when `--arms` names an arm that reads the materialized corpus (the same parsing as `parseArmIds`). */
export function agentArmsRequested(argv: readonly string[]): boolean {
  const i = argv.indexOf("--arms");
  if (i < 0) return false;
  const ids = (argv[i + 1] ?? "").split(",").map((s) => s.trim().toUpperCase());
  const materialized: readonly string[] = [...AGENT_ARMS, ...ANALYSIS_ARMS];
  return ids.some((id) => materialized.includes(id));
}

/** Point the database, the clones and the vectors at the materialized layout. */
export function bindMaterializedEnv(env: NodeJS.ProcessEnv, layout: MaterializeLayout): void {
  env.DATABASE_URL = layout.databaseUrl;
  env.REPO_CLONE_DIR = layout.cloneRoot;
  env.LANCEDB_PATH = layout.lancedbPath;
}
