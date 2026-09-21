import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";

/**
 * Issues #1384 and #1385 — the two `docs/USER_GUIDE.md` quickstart steps that a
 * fresh clone could not get through.
 *
 * Both were invisible on a developer's existing checkout and invisible in CI, for
 * the same reason: nothing anywhere executes the first-clone path. `migrate dev`
 * is never run by a workflow (the postgres jobs use `migrate deploy`, which does
 * not compare structure), and `db:seed` appears in no workflow at all. These tests
 * are the missing execution.
 *
 * Neither is a shape assertion over a config file. A config-shape check would have
 * passed happily on the Prisma 6 `"prisma": { "seed": ... }` block that #1385 found
 * dead — the declaration was present, live-looking and simply not read any more.
 * So the seed test RUNS the seed against a throwaway database and reads the rows
 * back through a plain SQLite handle, i.e. not through the client that wrote them.
 */

const repoRoot = resolve(__dirname, "..", "..");
const serverDir = resolve(repoRoot, "server");
/**
 * pnpm links a workspace package's own binaries under ITS node_modules/.bin, not
 * the root's — `prisma` is a `server` devDependency, so the root path does not
 * exist and resolving there fails with ENOENT, which reads as "the gate ran and
 * something else is broken" rather than "the gate never ran".
 */
const prismaBin = resolve(serverDir, "node_modules", ".bin", "prisma");

/** Temp databases created by the seed test, removed in `afterAll`. */
const tempDirs: string[] = [];

/**
 * Both subprocess tests need far more than `vitest.config.ts`'s 15s default, which was set
 * for HTTP round-trips rather than for spawning the Prisma CLI. The drift check runs one
 * `migrate diff`; the round-trip runs a `migrate deploy` over 114 migrations and then a
 * `db seed` that starts `tsx` and compiles the seed. Locally that is ~2s and ~3s; the `api`
 * job timed out at 15s on PR #1389 under parallel CI load, where this suite's own log showed
 * cumulative import time in the thousands of seconds. These budgets are generous on purpose
 * — a slow runner must not read as a broken migration — and `retry: 2` multiplies them.
 */
const DIFF_TIMEOUT_MS = 60_000;
const ROUND_TRIP_TIMEOUT_MS = 180_000;

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("issue #1384 — `pnpm db:migrate` on a fresh clone", () => {
  it(
    "has no structural drift between prisma/migrations and schema.prisma",
    () => {
      // `prisma migrate status` compares applied migration NAMES and sees nothing
      // wrong; `migrate diff` compares STRUCTURE, and structure is what `migrate dev`
      // consults before deciding to prompt for a new migration name. `--exit-code`
      // makes the difference the process exit status: 0 empty, 2 non-empty, 1 error.
      const result = spawnSync(
        prismaBin,
        [
          "migrate",
          "diff",
          "--from-migrations",
          "prisma/migrations",
          "--to-schema",
          "prisma/schema.prisma",
          "--script",
          "--exit-code",
        ],
        {
          cwd: serverDir,
          encoding: "utf-8",
          env: { ...process.env, DATABASE_URL: "file:./dev.db" },
        },
      );

      // A non-empty diff means every fresh `pnpm db:migrate` stops on
      // "Enter a name for the new migration". Assert on the SCRIPT, not just the exit
      // code, so a failure names the offending table instead of printing "2 !== 0".
      // Prisma writes "Loaded Prisma config from prisma.config.ts." to stderr on every
      // invocation; that banner is the only line dropped here, and `--exit-code` is
      // still asserted separately so trimming output cannot mask a real diff.
      const banner = /^Loaded Prisma config from .*$/gm;
      const script = `${result.stdout}${result.stderr}`.replace(banner, "").trim();

      // Two independent arms. The exit code is Prisma's own verdict; the DDL check
      // does not depend on that contract at all, so a future change to what
      // `--exit-code` means cannot quietly turn this gate into a pass. On an empty
      // diff Prisma prints only `-- This is an empty migration.`, which is why the
      // assertion is "contains no DDL" rather than "is the empty string".
      expect(script).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX)\b/i);
      expect(result.status, `unexpected schema drift:\n${script}`).toBe(0);
    },
    DIFF_TIMEOUT_MS,
  );
});

/**
 * The seed round-trip is structurally SQLite-only, for the reason #876 documents on
 * `src/lib/portability/logical-roundtrip.test.ts`: it builds a real SQLite file and the
 * seed constructs `PrismaClient` with `PrismaBetterSqlite3`, which a Postgres-generated
 * client rejects outright ("not compatible with the provider `postgres`"). The
 * incompatibility is baked into the generated artifact, so no harness setup bridges it —
 * better not asserted than asserted wrongly.
 *
 * This costs no PR coverage: the `api` job generates the SQLite client, which is the
 * default everywhere, so the round-trip runs on every PR. It skips only for the
 * `postgres-adapter` job's full-suite regression run and for local Postgres dogfooding.
 * The declaration check above is provider-independent and is NOT skipped, so the postgres
 * arm still fails if `migrations.seed` disappears.
 */
const itOnSqliteClient = it.skipIf(readGeneratedClientProvider() !== "sqlite");

describe("issue #1385 — `pnpm db:seed` on a fresh clone", () => {
  it("is declared where Prisma 7 reads it, and only there", async () => {
    // Prisma 7 reads `migrations.seed` from prisma.config.ts. The Prisma 6 home for
    // this, `server/package.json`'s `"prisma"` block, is no longer read at all — two
    // sources of truth where one disagrees silently is what #1385 was.
    const config = (await import("../prisma.config.js")).default as {
      migrations?: { seed?: string };
    };
    expect(config.migrations?.seed).toBeTruthy();

    const pkg = JSON.parse(readFileSync(resolve(serverDir, "package.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(pkg).not.toHaveProperty("prisma");
  });

  it("resolves the generated client's provider, so the round-trip below cannot skip silently", () => {
    // `readGeneratedClientProvider()` can also return "unknown" or null when it cannot read
    // the generated artifact, and `!== "sqlite"` treats both as "skip". That would delete the
    // round-trip from every job at once with a green suite — the same exit-0 fail-open shape
    // #1385 is about, one level up. This assertion is NOT skipped, so an unreadable artifact
    // goes red instead of quiet.
    expect(["sqlite", "postgresql"]).toContain(readGeneratedClientProvider());
  });

  itOnSqliteClient(
    "actually populates a freshly migrated database and says what it wrote",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "metis-seed-"));
      tempDirs.push(dir);
      const dbPath = join(dir, "quickstart.db");
      const env = { ...process.env, DATABASE_URL: `file:${dbPath}` };

      execFileSync(prismaBin, ["migrate", "deploy"], { cwd: serverDir, env, stdio: "pipe" });
      expect(existsSync(dbPath)).toBe(true);

      const seed = spawnSync(prismaBin, ["db", "seed"], { cwd: serverDir, env, encoding: "utf-8" });
      const output = `${seed.stdout}${seed.stderr}`;

      // THE fail-open this issue is about: Prisma prints this and exits 0, so every
      // caller — a new contributor, a script, a CI step — reads success.
      expect(output).not.toMatch(/No seed command configured/);
      expect(seed.status).toBe(0);
      expect(output).toMatch(/Seed complete/);

      // Read the rows back through a plain SQLite handle rather than the Prisma client
      // that wrote them: a write that reports success while the read cannot see it is
      // the defect shape a same-client assertion cannot detect.
      const db = new Database(dbPath, { readonly: true });
      try {
        const count = (table: string): number =>
          (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
        expect(count("roles")).toBeGreaterThan(0);
        expect(count("permissions")).toBeGreaterThan(0);
        expect(count("users")).toBeGreaterThan(0);
        expect(count("projects")).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    },
    ROUND_TRIP_TIMEOUT_MS,
  );
});
