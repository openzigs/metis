import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Guards the reachability claim behind the GHSA-mrwp-f3q8-3g9p waiver in
 * `.github/workflows/sast.yml` (#1635).
 *
 * The waiver rests on two facts: the only route to follow-redirects@1.16.1 is
 * axios 1.20.0, which the advisory says does not reproduce the cross-realm
 * `sensitiveHeaders` bug, and no METIS source calls axios or follow-redirects
 * directly (a direct caller is the advisory's precondition). If either stops
 * being true the waiver's reason is false, so this fails.
 *
 * Lifetime: the first arm requires a copy of 1.16.1 to exist, so it goes red once the
 * lockfile takes 1.16.2. That is deliberate — the #1635 bump PR must delete this file
 * together with the GHSA-mrwp-f3q8-3g9p waiver in sast.yml.
 */

const repoRoot = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");
const lockfile = fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");

describe("GHSA-mrwp-f3q8-3g9p waiver reachability (#1635)", () => {
  it("every package-snapshot parent of follow-redirects@1.16.1 is axios@1.20.0, and no importer depends on it directly", () => {
    const parents = [];
    let current = null;
    for (const line of lockfile.split("\n")) {
      const pkg = /^ {2}(\S.*?):\s*$/.exec(line);
      if (pkg) current = pkg[1].replace(/^'|'$/g, "");
      if (/^ {6}follow-redirects: 1\.16\.1\b/.test(line)) parents.push(current);
    }
    expect(parents.length).toBeGreaterThan(0);
    for (const parent of parents) expect(parent).toMatch(/^axios@1\.20\.0(\(|$)/);
    // An importer (a workspace package.json) writes a direct dependency as a
    // multi-line `follow-redirects:` / `specifier:` block under `importers:`.
    const importers = lockfile.split(/^packages:\s*$/m)[0];
    expect(importers).not.toMatch(/^ {6}(axios|follow-redirects):\s*$/m);
  });

  it("no METIS source imports axios or follow-redirects", () => {
    const dirs = ["server/src", "ui/src", "packages", "e2e", "scripts"].map((d) =>
      path.join(repoRoot, d),
    );
    const result = spawnSync(
      "grep",
      [
        "-rlE",
        "--include=*.ts",
        "--include=*.tsx",
        "--include=*.mts",
        "--include=*.js",
        "--include=*.mjs",
        "--include=*.cjs",
        "--include=*.cts",
        "--include=*.jsx",
        "--exclude-dir=node_modules",
        "--exclude-dir=dist",
        "(from|import|require\\(|import\\()\\s*['\"](axios|follow-redirects)['\"/]",
        ...dirs,
      ],
      { encoding: "utf8" },
    );
    // grep exits 1 when nothing matches; 2 is an error and must not read as "clean".
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
