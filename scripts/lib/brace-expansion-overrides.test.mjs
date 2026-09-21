import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ceilingMajorOf,
  floorOf,
  isAtLeast,
  parseTopLevelOverrides,
} from "./pnpm-overrides-core.mjs";

/**
 * Regression guard for GHSA-mh99-v99m-4gvg (#1089/#1208).
 *
 * `brace-expansion` changed its CommonJS export shape at the v4 major boundary:
 *
 *   v1/v2/v3  ->  module.exports = expandTop            // the module IS the function
 *   v4/v5     ->  exports.expand = expand               // named export on an object
 *
 * `minimatch@3.x` and `minimatch@5.x` are CommonJS and call the module directly
 * (`var expand = require('brace-expansion'); ... expand(pattern)`), so forcing them
 * onto v5 resolves fine and then throws `TypeError: expand is not a function` at the
 * first glob match — i.e. it breaks eslint/vitest/prettier tooling, not app code.
 * Only `minimatch@10.x` uses the named import (`import { expand } from ...`).
 *
 * The advisory fix is therefore per-line, not a single cross-major override:
 * fixed in 1.1.17, 2.1.3, 3.0.3 and 5.0.8. This test pins the two halves of that:
 * the v5 line must sit at or above its fixed floor, and the v1/v2 lines must stay
 * inside their own major so the CJS consumers keep a callable module.
 *
 * ## #1213: these assertions read the LOCKFILE, not the manifest
 *
 * Until #1213 they read `manifest.pnpm.overrides` from `package.json`. pnpm 11 stopped
 * reading that field — with a WARNING and exit 0 — so this guard would have kept
 * reporting 4/4 while every pin it names silently stopped applying. It now sources the
 * overrides from the lockfile's top-level `overrides:` block, which is what pnpm
 * actually applied. `scripts/lib/pnpm-overrides-core.test.mjs` carries the mutation
 * matrix for that, including the declared-but-not-honoured arm.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");

/**
 * The overrides pnpm ACTUALLY APPLIED. Not what any manifest asked for — `null` here
 * would mean pnpm applied none at all, which is a failure, not an empty set to iterate.
 */
const effective = parseTopLevelOverrides(lockfile);

describe("brace-expansion overrides (GHSA-mh99-v99m-4gvg)", () => {
  it("has an effective override set at all — a missing block means none were applied", () => {
    expect(
      effective,
      "pnpm-lock.yaml has no top-level `overrides:` block: pnpm applied NO overrides. " +
        "Under pnpm 11 this is what a package.json `pnpm` field produces (#1213).",
    ).not.toBeNull();
  });

  it("pins the v5 line at or above the 5.0.8 fixed floor", () => {
    const override = effective?.get("brace-expansion@5");
    expect(override, "the lockfile must apply an override for brace-expansion@5").toBeDefined();
    expect(
      isAtLeast(override, [5, 0, 8]),
      `brace-expansion@5 is "${override}"; the advisory is fixed in 5.0.8`,
    ).toBe(true);
  });

  it.each([
    ["brace-expansion@1", 1],
    ["brace-expansion@2", 2],
  ])("keeps %s inside its own major so CJS minimatch keeps a callable module", (key, major) => {
    const override = effective?.get(key);
    expect(override, `the lockfile must apply an override for ${key}`).toBeDefined();
    const crossMajor =
      `crossing to v4+ swaps module.exports for a named 'expand' export and ` +
      `breaks minimatch@3/@5 at runtime`;
    expect(floorOf(override)[0], `${key} floor is "${override}" — ${crossMajor}`).toBe(major);
    // The floor alone is not the guarantee: ">=1.1.17" has an in-major floor and
    // still installs 5.0.9. Require the range to be capped inside its major.
    expect(
      ceilingMajorOf(override),
      `${key} is "${override}", which is not bounded within major ${major} — ${crossMajor}. ` +
        `Use an exact pin, a ^/~ range, or an explicit "<${major + 1}.0.0" upper bound.`,
    ).toBe(major);
  });

  it("resolves no brace-expansion 4.x/5.x below 5.0.8 in the lockfile", () => {
    const resolved = [...lockfile.matchAll(/^ {2}brace-expansion@(\d+\.\d+\.\d+):/gm)]
      .map((m) => m[1])
      .filter((v) => Number(v.split(".")[0]) >= 4);
    expect(resolved.length, "expected at least one v4+ copy in the tree").toBeGreaterThan(0);
    for (const version of resolved) {
      expect(isAtLeast(version, [5, 0, 8]), `lockfile resolves ${version}`).toBe(true);
    }
  });
});
