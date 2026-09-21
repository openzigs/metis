import path from "node:path";
import { defineConfig } from "prisma/config";

// Issue #539 (epic #518) — resolve the schema + migrations directory by the
// `DATABASE_URL` scheme so Prisma CLI commands (`migrate deploy`, `generate`,
// `db seed`) target the right datasource WITHOUT needing an explicit
// `--schema` flag. Prisma 7 reads `migrations.path` from this config, so a
// `--schema` flag alone is NOT enough to switch the migration history — both
// must move together. This mirrors `scripts/dev-server-entrypoint.sh`, which
// picks the same paths by the same scheme rule:
//   - postgres:// / postgresql://  -> prisma/postgres/{schema.prisma,migrations}
//   - file: / sqlite: (or unset)   -> prisma/{schema.prisma,migrations}
const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");

const schemaDir = isPostgres ? path.join("prisma", "postgres") : "prisma";

export default defineConfig({
  schema: path.join(schemaDir, "schema.prisma"),
  migrations: {
    path: path.join(schemaDir, "migrations"),
    // Issue #1385 — `prisma db seed` reads the seed command from HERE in Prisma 7.
    // It used to live in `server/package.json` as `"prisma": { "seed": ... }`, which
    // Prisma 7 no longer reads: the declaration stayed there looking live while
    // `pnpm db:seed` printed "No seed command configured" and EXITED 0, so a fresh
    // clone silently got an empty database and a success message. The package.json
    // block is deleted rather than kept alongside — two sources of truth where only
    // one is read is the defect, not a typo in one of them.
    //
    // The path is relative to `server/` (Prisma resolves it against this config's
    // directory), so it is correct on BOTH arms: `schemaDir` above swings the schema
    // and migration history by `DATABASE_URL` scheme (#539), but there is one
    // `prisma/seed.ts` and it drives whichever datasource `DATABASE_URL` names.
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: databaseUrl,
  },
});
