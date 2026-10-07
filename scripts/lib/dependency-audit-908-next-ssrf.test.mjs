import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseTopLevelOverrides,
  rangeMeetsFloor,
  resolvedLockfileVersions,
  resolvedVersionMeetsFloor,
} from "./pnpm-overrides-core.mjs";

/**
 * Regression guard for GHSA-cjq9-62q9-8jv4 (#908), published 2026-10-07T20:30Z against an
 * unchanged lockfile, which turned `Dependency audit` red on `main` and every PR:
 *
 *   GHSA-cjq9-62q9-8jv4  next  HIGH, CVSS v4 8.3 (v3.1 6.5)  SSRF in Image Optimization
 *                              introduced 16.0.0, fixed 16.3.8
 *
 * METIS renders through `next/image`, so the Image Optimization path is live. The same
 * 2026-10-07 batch carried five Low/Moderate next advisories (GHSA-39w2-rjm5-chcv,
 * -3w37-wq28-93x7, -4jqv-mc3x-m676, -f87g-xv8r-7p7x, -mcj8-r9mp-w47p), every one fixed
 * in 16.3.8 too; api.osv.dev returned zero vulns for next@16.3.8 on 2026-10-07.
 *
 * Same shape and reasoning as `dependency-audit-903-advisories.test.mjs`: the audit is a
 * live OSV query, so it alarms well and regresses poorly. This file is what objects when
 * the pin is later deleted or weakened. Every arm reads the RESOLVED lockfile or the
 * declaring manifest, never an override string alone.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
const effective = parseTopLevelOverrides(lockfile);

/** @typedef {readonly [number, number, number]} Triple */

const FIXED = /** @type {Triple} */ ([16, 3, 8]);

/**
 * @param {string} manifestPath repo-relative
 * @param {string} name
 * @returns {string | undefined}
 */
function declaredRange(manifestPath, name) {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, manifestPath), "utf8"));
  for (const block of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const range = manifest[block]?.[name];
    if (range) return range;
  }
  return undefined;
}

/**
 * Asserts every resolved copy of `name` is at or above FIXED. Fails on an EMPTY result
 * too: a lookup that finds nothing would otherwise read as "no vulnerable copy present".
 *
 * @param {string} name
 * @param {string} why
 */
function expectNoCopyBelowFixed(name, why) {
  const resolved = resolvedLockfileVersions(lockfile, name);
  expect(resolved.length, `expected at least one ${name} copy in the tree`).toBeGreaterThan(0);
  const breaching = resolved.filter((v) => !resolvedVersionMeetsFloor(v, FIXED));
  expect(
    breaching,
    `lockfile resolves ${name} ${breaching.join(", ")} below ${FIXED.join(".")}. ${why}`,
  ).toEqual([]);
}

describe("GHSA-cjq9-62q9-8jv4 (next SSRF in Image Optimization) is closed in the resolved tree", () => {
  it("has an effective override set at all", () => {
    expect(effective, "pnpm-lock.yaml has no top-level `overrides:` block").not.toBeNull();
  });

  it("ui/package.json declares next ^16.3.8 or above", () => {
    const range = declaredRange("ui/package.json", "next");
    expect(range, "ui/package.json no longer declares next").toBeDefined();
    expect(rangeMeetsFloor(range, FIXED), `ui/package.json declares next "${range}"`).toBe(true);
  });

  it("ui/package.json moves eslint-config-next with next", () => {
    // eslint-config-next pins @next/eslint-plugin-next EXACTLY to its own version, so a
    // stale range here keeps a second @next/* line in the tree on the old release.
    const range = declaredRange("ui/package.json", "eslint-config-next");
    expect(range, "ui/package.json no longer declares eslint-config-next").toBeDefined();
    expect(rangeMeetsFloor(range, FIXED), `ui/package.json declares "${range}"`).toBe(true);
  });

  it("the next override targets 16.3.8 and bounds at 16.3.8 (#1208)", () => {
    const entries = [...(effective?.entries() ?? [])].filter(
      ([key]) => key === "next" || key.startsWith("next@"),
    );
    // An empty list would pass every assertion in the loop below: fail-open.
    expect(entries, "no override governs next").not.toHaveLength(0);
    for (const [key, target] of entries) {
      expect(
        rangeMeetsFloor(target, FIXED),
        `override "${key}" targets "${target}", below the fixed ${FIXED.join(".")}`,
      ).toBe(true);
      const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
      if (ceiling !== undefined) {
        expect(
          resolvedVersionMeetsFloor(ceiling, FIXED),
          `override key "${key}" bounds at ${ceiling}, below the fixed ${FIXED.join(".")}: ` +
            "a consumer whose declared range sits between the two is never governed (#1208)",
        ).toBe(true);
      }
    }
  });

  it("resolves no next copy below 16.3.8", () => {
    expectNoCopyBelowFixed(
      "next",
      "Image Optimization fetches attacker-influenced URLs server-side (SSRF, GHSA-cjq9-62q9-8jv4).",
    );
  });

  it("resolves no @next/env copy below 16.3.8", () => {
    expectNoCopyBelowFixed("@next/env", "next pins @next/env exactly, so it moves only with next.");
  });

  it("resolves no @next/eslint-plugin-next copy below 16.3.8", () => {
    expectNoCopyBelowFixed(
      "@next/eslint-plugin-next",
      "eslint-config-next pins it exactly, so it moves only with eslint-config-next.",
    );
  });
});
