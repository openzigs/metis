import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseTopLevelOverrides,
  resolvedLockfileVersions,
  resolvedVersionMeetsFloor,
} from "./pnpm-overrides-core.mjs";

/**
 * GHSA-587h-7wmj-h5pm, vite (via its bundled launch-editor), CVSS 7.5 — published
 * 2026-10-20T19:48Z against an UNCHANGED lockfile, and found by reproducing the
 * `Dependency audit` gate locally (it surfaced while working #777). It turned the gate red on `main`
 * and on every PR at once, so a PR re-dating the braces waiver could not have shown green.
 *
 * OSV records one affected band per line: `8.3.0 -> fixed 8.3.3`, `8.2.0 -> 8.2.4`,
 * `8.0.0 -> 8.1.6`, `7.0.0 -> 7.3.7`, `0 -> 6.4.4`. The tree took 8.3.1. 8.3.3 was
 * published 2026-10-06 and 8.3.4 on 2026-10-08, both clear of the 7-day
 * `minimumReleaseAge`; api.osv.dev returned zero vulns for each on 2026-10-20, and 8.3.4
 * also clears the two Medium launch-editor advisories the same lockfile carried.
 *
 * vite is dev-only here (vitest, @vitejs/plugin-react, the root devDependency), but the
 * gate is CVSS-driven and does not read reachability, so the remedy is the bump. These
 * arms read the RESOLVED lockfile, so they fail on a reverted override, a weakened
 * target, or a new consumer dragging an old copy back in.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
const FIXED = /** @type {[number, number, number]} */ ([8, 3, 3]);

describe("GHSA-587h-7wmj-h5pm — vite resolves at or above 8.3.3", () => {
  it("resolves no vite below 8.3.3", () => {
    const versions = resolvedLockfileVersions(lockfile, "vite");
    expect(versions, "pnpm-lock.yaml resolves no vite at all").not.toHaveLength(0);
    for (const version of versions) {
      expect(
        resolvedVersionMeetsFloor(version, FIXED),
        `vite@${version} is inside GHSA-587h-7wmj-h5pm (fixed 8.3.3 on the 8.3 line)`,
      ).toBe(true);
    }
  });

  it("pins the override target at 8.3.3 or above", () => {
    const overrides = parseTopLevelOverrides(lockfile);
    const target = overrides?.get("vite");
    expect(target, "no `vite` override in the lockfile's applied overrides").toBeDefined();
    const floor = /(\d+)\.(\d+)\.(\d+)/.exec(/** @type {string} */ (target));
    expect(floor, `vite override "${target}" carries no version`).not.toBeNull();
    expect(
      resolvedVersionMeetsFloor(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
      `vite override targets "${target}"; a re-resolve could land back on 8.3.1`,
    ).toBe(true);
  });

  it("declares ^8.3.3 or above in the root package.json", () => {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
    const range = manifest.devDependencies?.vite;
    expect(range, "root package.json declares no vite devDependency").toBeDefined();
    const floor = /(\d+)\.(\d+)\.(\d+)/.exec(range);
    expect(floor).not.toBeNull();
    expect(resolvedVersionMeetsFloor(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED)).toBe(true);
  });
});
