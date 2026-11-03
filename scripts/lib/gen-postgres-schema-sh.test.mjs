import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * #1710 — `pnpm --filter @metis/server db:gen-postgres` runs
 * `bash ../scripts/gen-postgres-schema.sh` with the working directory set to
 * `server/`, and the script resolved `server/prisma/schema.prisma` against the
 * CALLER's working directory, so it exited "not found — run from repo root".
 *
 * The script is run from a throwaway copy of the layout it needs
 * (`<root>/scripts/gen-postgres-schema.sh` + `<root>/server/prisma/schema.prisma`),
 * so the real generated schema in this checkout is never written by a test.
 */

const repoScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "gen-postgres-schema.sh",
);

const posix = process.platform !== "win32";
const tmpRoots = [];

function mkTmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}

const SOURCE = [
  "// METIS Prisma schema — DEV (SQLite).",
  "//",
  "// header line three",
  "datasource db {",
  '  provider = "sqlite"',
  '  url      = env("DATABASE_URL")',
  "}",
  "",
  "model Thing {",
  "  id String @id",
  "}",
  "",
].join("\n");

let fakeRepo;
let outside;
let dst;

beforeAll(() => {
  if (!posix) return;
  fakeRepo = mkTmp("metis-gen-postgres-repo-");
  fs.mkdirSync(path.join(fakeRepo, "scripts"));
  fs.mkdirSync(path.join(fakeRepo, "server", "prisma", "postgres"), { recursive: true });
  fs.copyFileSync(repoScript, path.join(fakeRepo, "scripts", "gen-postgres-schema.sh"));
  fs.writeFileSync(path.join(fakeRepo, "server", "prisma", "schema.prisma"), SOURCE);
  dst = path.join(fakeRepo, "server", "prisma", "postgres", "schema.prisma");
  outside = mkTmp("metis-gen-postgres-elsewhere-");
});

afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/** Run the copied script the way a caller in `cwd` would reach it. */
function run(cwd, scriptArg) {
  if (fs.existsSync(dst)) fs.rmSync(dst);
  return spawnSync("bash", [scriptArg], { cwd, encoding: "utf8" });
}

function expectGenerated(result) {
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const out = fs.readFileSync(dst, "utf8");
  expect(out.startsWith("// METIS Prisma schema — PROD (PostgreSQL).\n")).toBe(true);
  expect(out).toContain('  provider = "postgresql"\n');
  expect(out).not.toContain('provider = "sqlite"');
  expect(out).not.toContain("header line three");
  expect(out).toContain("model Thing {\n  id String @id\n}\n");
}

describe.skipIf(!posix)("scripts/gen-postgres-schema.sh working directory (#1710)", () => {
  it("generates the Postgres schema when run from server/, as pnpm --filter does", () => {
    expectGenerated(run(path.join(fakeRepo, "server"), "../scripts/gen-postgres-schema.sh"));
  });

  it("still generates it when run from the repo root", () => {
    expectGenerated(run(fakeRepo, "scripts/gen-postgres-schema.sh"));
  });

  it("generates it from an unrelated directory via an absolute path", () => {
    expectGenerated(run(outside, path.join(fakeRepo, "scripts", "gen-postgres-schema.sh")));
  });

  it("fails loudly, naming the source, when the canonical schema is missing", () => {
    const bare = mkTmp("metis-gen-postgres-bare-");
    fs.mkdirSync(path.join(bare, "scripts"));
    fs.copyFileSync(repoScript, path.join(bare, "scripts", "gen-postgres-schema.sh"));
    const result = spawnSync("bash", ["scripts/gen-postgres-schema.sh"], {
      cwd: bare,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("server/prisma/schema.prisma not found");
  });
});
