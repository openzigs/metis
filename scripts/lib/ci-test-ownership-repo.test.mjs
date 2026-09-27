import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { auditOwnership, testOwnership } from "./ci-test-ownership-core.mjs";

/**
 * #4 — every workspace package's unit suite runs in exactly ONE default-configuration
 * CI job, and the jobs that re-run a suite under another configuration keep doing so.
 *
 * `api` used to run the root `pnpm test` (the whole monorepo) while `ui` and
 * `postgres-adapter` ran two of those suites again. Narrowing `api` is only safe if
 * nothing is lost, and "nothing is lost" is not something a reviewer can see in a
 * diff of a 1,200-line workflow. This test makes it a red build.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** @param {string} rel */
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

/**
 * Jobs that re-run a package's suite under a DIFFERENT configuration, deliberately.
 * They never count as that package's owner — a variant run is not a substitute.
 */
const VARIANT_JOBS = Object.freeze({
  // The server suite against the POSTGRES-generated Prisma client (#876). 14 files
  // (288 tests, every `*.sqlite.test.ts` among them) skip themselves there, so it
  // cannot replace the SQLite run — measured on #4.
  "postgres-adapter": ["@metis/server"],
  // win32. Its gating steps run the scripts suite; the full suite is non-gating.
  windows: ["@metis/scripts"],
});

/** The workspace packages, root included, from pnpm-workspace.yaml's `packages:` list. */
function workspacePackages() {
  const yaml = read("pnpm-workspace.yaml");
  const block = yaml.slice(yaml.indexOf("packages:")).split("\n").slice(1);
  /** @type {string[]} */
  const patterns = [];
  for (const line of block) {
    const m = line.match(/^\s+-\s+["']?([^"'\s#]+)["']?/);
    if (!m) break;
    patterns.push(m[1]);
  }
  const dirs = patterns.flatMap((p) => {
    if (!p.endsWith("/*")) return [p];
    const parent = p.slice(0, -2);
    return fs
      .readdirSync(path.join(repoRoot, parent), { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() && fs.existsSync(path.join(repoRoot, parent, d.name, "package.json")),
      )
      .map((d) => `${parent}/${d.name}`);
  });
  return [".", ...dirs].map((dir) => {
    const pkg = JSON.parse(read(path.join(dir, "package.json")));
    return {
      name: pkg.name,
      dir,
      hasTest: Boolean(pkg.scripts?.test),
      testScript: pkg.scripts?.test,
    };
  });
}

describe("CI unit-suite ownership (#4)", () => {
  const packages = workspacePackages();
  const owners = testOwnership(read(".github/workflows/ci.yml"), packages);

  it("reads the real workspace (guards against an empty, trivially-passing audit)", () => {
    expect(packages.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        "@metis/server",
        "@metis/ui",
        "@metis/shared",
        "@metis/scripts",
        "@metis/e2e",
      ]),
    );
    expect(owners.size).toBeGreaterThanOrEqual(6);
  });

  it("runs every package's unit suite in exactly one default-configuration job", () => {
    expect(auditOwnership(owners, VARIANT_JOBS)).toEqual([]);
  });

  it("keeps the ui suite in `ui` and the SQLite server suite out of `postgres-adapter`", () => {
    const primary = (/** @type {string} */ pkg) =>
      (owners.get(pkg) ?? []).filter((j) => !(j in VARIANT_JOBS));
    expect(primary("@metis/ui")).toEqual(["ui"]);
    expect(primary("@metis/server")).toEqual(["server"]);
    expect(primary("@metis/shared")).toEqual(["api"]);
  });
});
