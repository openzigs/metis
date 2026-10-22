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
 * Regression guard for the 2026-10-22 batch (#1420), published against an unchanged
 * lockfile, which turned `Dependency audit` red on `main` and every PR:
 *
 *   GHSA-2464-fhr4-w9xw  next       CRITICAL, CVSS 9.5  unauthenticated RCE in the Image
 *                                   Optimization API with SVG; fixed 16.4.1
 *   GHSA-p3m5-59mp-jv5r  next       HIGH, CVSS 8.2      App Router Server Actions DoS;
 *                                   fixed 16.4.1
 *   GHSA-mrv2-3pqr-j5jr  dompurify  HIGH, CVSS 7.6      IN_PLACE hook leaves a detached
 *                                   subtree's event handlers armed (incomplete fix for
 *                                   GHSA-p98j-92pf-mc4p); introduced 0, fixed 3.4.17
 *
 * Same shape as `dependency-audit-908-next-ssrf.test.mjs`: the audit is a live OSV query,
 * so it alarms well and regresses poorly. This file is what objects when a pin is later
 * deleted or weakened. Every arm reads the RESOLVED lockfile or the declaring manifest,
 * never an override string alone.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
const effective = parseTopLevelOverrides(lockfile);

/** @typedef {readonly [number, number, number]} Triple */

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

/** @type {ReadonlyArray<{ name: string, fixed: Triple, why: string }>} */
const CASES = [
  {
    name: "next",
    fixed: [16, 4, 1],
    why: "GHSA-2464-fhr4-w9xw (RCE via Image Optimization with SVG) and GHSA-p3m5-59mp-jv5r (Server Actions DoS).",
  },
  {
    name: "dompurify",
    fixed: [3, 4, 17],
    why: "GHSA-mrv2-3pqr-j5jr: a sanitiser hook can leave event handlers armed; mermaid carries its own copy.",
  },
];

describe("the #1420 advisories are closed in the resolved tree", () => {
  it("has an effective override set at all", () => {
    expect(effective, "pnpm-lock.yaml has no top-level `overrides:` block").not.toBeNull();
  });

  for (const { name, fixed, why } of CASES) {
    const floor = fixed.join(".");

    it(`ui/package.json declares ${name} at or above ${floor}`, () => {
      const range = declaredRange("ui/package.json", name);
      expect(range, `ui/package.json no longer declares ${name}`).toBeDefined();
      expect(rangeMeetsFloor(range, fixed), `ui/package.json declares ${name} "${range}"`).toBe(
        true,
      );
    });

    it(`the ${name} override targets and bounds at ${floor} (#1208)`, () => {
      const entries = [...(effective?.entries() ?? [])].filter(
        ([key]) => key === name || key.startsWith(`${name}@`),
      );
      // An empty list would pass every assertion in the loop below: fail-open.
      expect(entries, `no override governs ${name}`).not.toHaveLength(0);
      for (const [key, target] of entries) {
        expect(
          rangeMeetsFloor(target, fixed),
          `override "${key}" targets "${target}", below the fixed ${floor}`,
        ).toBe(true);
        const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
        if (ceiling !== undefined) {
          expect(
            resolvedVersionMeetsFloor(ceiling, fixed),
            `override key "${key}" bounds at ${ceiling}, below the fixed ${floor}: ` +
              "a consumer whose declared range sits between the two is never governed (#1208)",
          ).toBe(true);
        }
      }
    });

    it(`resolves no ${name} copy below ${floor}`, () => {
      const resolved = resolvedLockfileVersions(lockfile, name);
      // Fails on an EMPTY result too: a lookup that finds nothing would otherwise read as
      // "no vulnerable copy present".
      expect(resolved.length, `expected at least one ${name} copy in the tree`).toBeGreaterThan(0);
      const breaching = resolved.filter((v) => !resolvedVersionMeetsFloor(v, fixed));
      expect(
        breaching,
        `lockfile resolves ${name} ${breaching.join(", ")} below ${floor}. ${why}`,
      ).toEqual([]);
    });
  }

  it("resolves no @next/env copy below 16.4.1", () => {
    // next pins @next/env exactly, so it moves only with next.
    const breaching = resolvedLockfileVersions(lockfile, "@next/env").filter(
      (v) => !resolvedVersionMeetsFloor(v, [16, 4, 1]),
    );
    expect(breaching).toEqual([]);
  });
});
