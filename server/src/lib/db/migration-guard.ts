/**
 * Schema-drift guard (Issues #379, #380).
 *
 * Runs `prisma migrate deploy` synchronously at server startup to ensure the
 * database schema matches the current Prisma schema BEFORE the HTTP server
 * begins accepting traffic. This prevents the silent 500-class failures that
 * occur when a column referenced by application code is missing from the live
 * DB (e.g. `projects.overviewMarkdown`, `mcp_servers.userId`).
 *
 * Behavior:
 *   - Production (`NODE_ENV=production`): apply pending migrations. Any error
 *     causes `process.exit(1)`. The intent is fail-loud, fail-fast — never
 *     start the server with a drifted schema.
 *   - Development / test: same as production, but the operation is also a
 *     no-op when the schema is already up-to-date (idempotent).
 *   - Skipped when `METIS_SKIP_MIGRATE=1` (used by unit tests that mock
 *     Prisma, by CI jobs that manage migrations externally, and by callers
 *     that have already run `prisma migrate deploy` out-of-band).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("migration-guard");

export interface MigrationGuardOptions {
  /** Override `process.cwd()` — the directory containing `prisma/schema.prisma`. */
  cwd?: string;
  /** Override the spawn implementation (test seam). */
  spawn?: typeof spawnSync;
  /** Override `process.env` (test seam). */
  env?: NodeJS.ProcessEnv;
  /** Override how the Prisma CLI entry point is located (test seam). */
  resolvePrismaCli?: () => string;
}

export interface MigrationGuardResult {
  status: "applied" | "skipped";
  reason?: string;
}

/**
 * Resolve the directory that contains `prisma/schema.prisma`. In a packaged
 * build the compiled file lives under `dist/lib/db/`; in `tsx` dev it lives
 * under `src/lib/db/`. Either way the prisma schema sits at `<server>/prisma/`.
 */
function resolveServerRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/lib/db -> ../../.. = server/
  // dist/lib/db -> ../../.. = server/
  return path.resolve(here, "..", "..", "..");
}

/**
 * The Prisma CLI's entry script, resolved from this package the way `server/dist`
 * resolves every other dependency. `prisma` is a server `dependency`, so this is
 * present in a dev checkout and in the production image alike.
 */
function resolvePrismaCliDefault(): string {
  return createRequire(import.meta.url).resolve("prisma/build/index.js");
}

export async function ensureSchemaUpToDate(
  opts: MigrationGuardOptions = {},
): Promise<MigrationGuardResult> {
  const env = opts.env ?? process.env;
  if (env.METIS_SKIP_MIGRATE === "1") {
    log.info("Schema migration guard skipped via METIS_SKIP_MIGRATE=1");
    return { status: "skipped", reason: "METIS_SKIP_MIGRATE=1" };
  }
  const cwd = opts.cwd ?? resolveServerRoot();
  const spawn = opts.spawn ?? spawnSync;
  let cli: string;
  try {
    cli = (opts.resolvePrismaCli ?? resolvePrismaCliDefault)();
  } catch (err) {
    throw new Error(
      `Schema migration guard: the Prisma CLI is not installed, so pending migrations ` +
        `cannot be applied: ${(err as Error).message}`,
    );
  }
  log.info("Applying pending Prisma migrations", { cwd });
  // #39 — run the CLI with THIS node rather than through `pnpm exec`: the production
  // image ships no package manager, so `pnpm` failed with ENOENT and the server
  // refused to start. It also needs no shell on any platform (the `pnpm.cmd` shim
  // was the only reason Windows had one). argv is fixed; nothing untrusted reaches it.
  const result = spawn(process.execPath, [cli, "migrate", "deploy"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    shell: false,
  });
  if (result.error) {
    throw new Error(
      `Schema migration guard: failed to spawn prisma migrate deploy: ${result.error.message}`,
    );
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    const stdout = (result.stdout ?? "").toString().trim();
    throw new Error(
      `Schema migration guard: prisma migrate deploy exited ${result.status}.\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
  log.info("Schema migration guard: database is up-to-date");
  return { status: "applied" };
}
