import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isAtLeast, parseTopLevelOverrides, rangeMeetsFloor } from "./pnpm-overrides-core.mjs";

/**
 * Regression guard for the four High advisories that held `Dependency audit` red on
 * `main` from 2026-08-16 to 2026-08-27 (#1324).
 *
 *   GHSA-2v37-7h3g-55p8  nanoid        CVSS 8.2  introduced 0      fixed 3.3.18
 *   GHSA-ggr8-5vv4-36mx  deepmerge-ts  CVSS 8.2  introduced 0      fixed 8.0.0
 *   GHSA-r292-9mhp-454m  tar           CVSS 7.5  introduced 0      fixed 7.5.21
 *   GHSA-jmr9-qjv8-65gv  extract-zip   CVSS 8.6  introduced 0      NO FIX EXISTS
 *
 * ## Why a local guard, when `Dependency audit` already runs on every PR
 *
 * Same reason as `pdfjs-overrides.test.mjs` (#1273): that gate is a LIVE OSV FEED. It is
 * an excellent alarm and a poor regression test. Delete one of these overrides in six
 * months, when the feed has moved on or the advisory has been re-scoped, and nothing
 * local objects — `pnpm-overrides-repo.test.mjs` will not either, because its
 * `MINIMUM_OVERRIDES` is a collapse floor that a 30-override set clears with one pin
 * missing.
 *
 * ## Every assertion reads the RESOLVED TREE, not the selector alone
 *
 * A test that re-reads an override string and checks it says what it says pins nothing.
 * The load-bearing arms below scan `pnpm-lock.yaml` for what actually resolved, so they
 * fail on a deleted override, on a weakened target, AND on a new transitive consumer
 * dragging a vulnerable copy back in — none of which a selector-shaped assertion catches.
 * Overrides are read from the LOCKFILE's top-level `overrides:` block per #1213: that is
 * what pnpm applied, whereas a manifest `pnpm` field is ignored under pnpm 11 with a
 * warning and exit 0.
 *
 * ## nanoid's target is 3.3.18, and the reason is the point
 *
 * #1291 recorded 3.3.17 as this advisory's fix and verified it returned zero vulns at the
 * time. OSV has since re-scoped GHSA-2v37-7h3g-55p8 to `fixed 3.3.18`, so taking the
 * previously recorded target verbatim would have left the gate red having "done the
 * upgrade" — the losing bet of #1240, #1273 and #1291, three times in a row. The floor
 * asserted here is the advisory's CURRENT `fixed` event, re-read at bump time.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");

const effective = parseTopLevelOverrides(lockfile);

/**
 * Every version of `name` the lockfile actually resolves.
 *
 * Matches the two-space-indented `name@x.y.z:` snapshot/package keys, which is the form
 * `pdfjs-overrides.test.mjs` reads and the only place a resolved version appears
 * unqualified.
 *
 * **The optional leading quote is load-bearing.** pnpm writes a SCOPED key quoted
 * (`'@puppeteer/browsers@3.2.1':`) and an unscoped one bare (`tar@7.5.22:`). The first
 * draft of this helper copied the unscoped-only pattern from `pdfjs-overrides.test.mjs`
 * and matched zero copies of `@puppeteer/browsers` — a lookup that finds nothing reads as
 * "no vulnerable version present", which is the fail-open shape this whole file exists to
 * guard against. It was caught only because the arm asserts a non-empty result BEFORE
 * filtering; that ordering is the reason the defect surfaced rather than shipping green.
 *
 * **Matching is by string prefix, and the only regex is a literal.** An interpolated
 * `new RegExp()` here is a `detect-non-literal-regexp` finding that blocks the Semgrep
 * job, and escaping the package name to satisfy it would be defending against a ReDoS
 * that cannot happen (every caller passes a hardcoded constant) while leaving harder-to-
 * read code behind. Prefix matching is exact, needs no escaping, and cannot be tricked by
 * a `.` in a package name — which the regex form only handled because of the escape.
 *
 * @param {string} name
 * @returns {string[]}
 */
function resolvedVersions(name) {
  const bare = `  ${name}@`;
  const quoted = `  '${name}@`;
  const versions = new Set();
  for (const line of lockfile.split("\n")) {
    let rest;
    if (line.startsWith(bare)) rest = line.slice(bare.length);
    else if (line.startsWith(quoted)) rest = line.slice(quoted.length);
    else continue;
    // Literal, non-interpolated, and anchored: a resolved key ends at the version, so a
    // selector line (`tar@<7.5.21: ^7.5.21`) and a peer-suffixed snapshot key
    // (`puppeteer@25.8.0(yauzl@2.10.0):`) are both correctly excluded.
    const match = /^(\d+\.\d+\.\d+)'?:$/.exec(rest);
    if (match) versions.add(match[1]);
  }
  return [...versions];
}

/**
 * Override entries governing `name`, DERIVED from what pnpm applied.
 *
 * Deliberately not a hardcoded key. #1273's panel caught an arm that compared one literal
 * in the test against another literal in the test — unfalsifiable by any edit to the real
 * configuration. Deriving the key means a rename, a widened band or a dropped bound all
 * reach the assertions.
 *
 * @param {string} name
 * @returns {Array<[string, string]>}
 */
function overridesFor(name) {
  return [...(effective?.entries() ?? [])].filter(
    ([key]) => key === name || key.startsWith(`${name}@`),
  );
}

describe("the #1324 advisory set is closed in the resolved tree", () => {
  it("has an effective override set at all — a missing block means none were applied", () => {
    expect(
      effective,
      "pnpm-lock.yaml has no top-level `overrides:` block: pnpm applied NO overrides. " +
        "Under pnpm 11 this is what a package.json `pnpm` field produces (#1213).",
    ).not.toBeNull();
  });

  describe("nanoid — GHSA-2v37-7h3g-55p8 (CVSS 8.2), 3.x fixed in 3.3.18", () => {
    const FIXED_3X = [3, 3, 18];
    // The advisory's second range is `introduced 4.0.0, fixed 5.1.6`; 6.x is outside it.
    const FIXED_4X = [5, 1, 6];

    it("targets 3.3.18 or above on the 3.x line", () => {
      const three = overridesFor("nanoid").filter(([key]) => /^nanoid@[~^]?3/.test(key));
      expect(
        three,
        "no override governs nanoid 3.x, so postcss's copy is unpinned",
      ).not.toHaveLength(0);
      for (const [key, target] of three) {
        expect(
          isAtLeast(target, FIXED_3X),
          `override "${key}" targets "${target}"; GHSA-2v37-7h3g-55p8 is fixed in 3.3.18 ` +
            "on the 3.x line. 3.3.17 was the target #1291 recorded and OSV has since " +
            "re-scoped the advisory to cover it — a fix version is a bet that no later " +
            "advisory covers it, and that bet has now lost four times.",
        ).toBe(true);
      }
    });

    it("resolves NO nanoid copy inside either affected range", () => {
      const resolved = resolvedVersions("nanoid");
      expect(resolved.length, "expected at least one nanoid copy in the tree").toBeGreaterThan(0);
      const breaching = resolved.filter((v) => {
        // Range 1: [0, 3.3.18).  Range 2: [4.0.0, 5.1.6).
        if (!isAtLeast(v, [4, 0, 0])) return !isAtLeast(v, FIXED_3X);
        return !isAtLeast(v, FIXED_4X);
      });
      expect(
        breaching,
        `lockfile resolves nanoid ${breaching.join(", ")} inside an affected range of ` +
          "GHSA-2v37-7h3g-55p8 — a custom generator loops indefinitely on a zero size",
      ).toEqual([]);
    });
  });

  describe("deepmerge-ts — GHSA-ggr8-5vv4-36mx (CVSS 8.2), fixed in 8.0.0", () => {
    const FIXED = [8, 0, 0];

    it("targets 8.0.0 or above", () => {
      const entries = overridesFor("deepmerge-ts");
      expect(entries, "no override governs deepmerge-ts").not.toHaveLength(0);
      for (const [key, target] of entries) {
        expect(
          isAtLeast(target, FIXED),
          `override "${key}" targets "${target}"; the advisory covers introduced 0 -> ` +
            "fixed 8.0.0, so the ENTIRE 7.x line is affected and 7.1.6 does not close it",
        ).toBe(true);
      }
    });

    it("bounds the selector at the advisory's `fixed` event, not above it (#1208)", () => {
      for (const [key, target] of overridesFor("deepmerge-ts")) {
        const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
        expect(
          ceiling,
          `override key "${key}" carries no explicit \`<\` upper bound, so it matches every ` +
            "version above its floor — including majors this advisory says nothing about",
        ).toBe(FIXED.join("."));
        expect(
          isAtLeast(target, FIXED),
          `override "${key}" targets "${target}", below its own ceiling — the selector ` +
            "would keep matching its own result",
        ).toBe(true);
      }
    });

    it("resolves NO deepmerge-ts copy below 8.0.0", () => {
      const resolved = resolvedVersions("deepmerge-ts");
      expect(
        resolved.length,
        "expected at least one deepmerge-ts copy in the tree",
      ).toBeGreaterThan(0);
      const breaching = resolved.filter((v) => !isAtLeast(v, FIXED));
      expect(
        breaching,
        `lockfile resolves deepmerge-ts ${breaching.join(", ")} below 8.0.0 — stack ` +
          "exhaustion when merging a recursive object graph",
      ).toEqual([]);
    });
  });

  describe("tar — GHSA-r292-9mhp-454m (CVSS 7.5), fixed in 7.5.21", () => {
    const FIXED = [7, 5, 21];

    it("targets 7.5.21 or above", () => {
      const entries = overridesFor("tar");
      expect(entries, "no override governs tar").not.toHaveLength(0);
      for (const [key, target] of entries) {
        expect(
          isAtLeast(target, FIXED),
          `override "${key}" targets "${target}"; GHSA-r292-9mhp-454m is fixed in 7.5.21`,
        ).toBe(true);
      }
    });

    it("resolves NO tar copy below 7.5.21", () => {
      const resolved = resolvedVersions("tar");
      expect(resolved.length, "expected at least one tar copy in the tree").toBeGreaterThan(0);
      const breaching = resolved.filter((v) => !isAtLeast(v, FIXED));
      expect(
        breaching,
        `lockfile resolves tar ${breaching.join(", ")} below 7.5.21 — uncontrolled ` +
          "recursion in mapHas/filesFilter, an UNCATCHABLE stack-overflow DoS from a " +
          "crafted long-path archive. onnxruntime-node extracts one at install time.",
      ).toEqual([]);
    });
  });

  describe("extract-zip — GHSA-jmr9-qjv8-65gv (CVSS 8.6), NO FIXED VERSION", () => {
    /**
     * OSV records `last_affected: 2.0.1` with **no `fixed` event**, and 2.0.1 (June 2020)
     * is still the latest publish — the package is unmaintained, so EVERY version is
     * affected and no override can close this. The only lawful resolutions were to drop
     * the dependency or to waive it.
     *
     * It was dropped. Its sole consumer was `@puppeteer/browsers@2.13.2` via
     * `puppeteer@24.x`; `@puppeteer/browsers@3.x` replaced extract-zip with `modern-tar`,
     * so bumping the first-party `puppeteer` dependency to `^25.8.0` removes it from the
     * graph entirely. That is why this arm asserts ABSENCE rather than a floor: there is
     * no floor to assert, and a version-band assertion here would be quietly vacuous.
     */
    it("resolves no extract-zip copy at all", () => {
      const resolved = resolvedVersions("extract-zip");
      expect(
        resolved,
        `lockfile resolves extract-zip ${resolved.join(", ")}. Every published version is ` +
          "affected by GHSA-jmr9-qjv8-65gv (unvalidated symlink path traversal, CVSS 8.6) " +
          "and the package is unmaintained, so no override can fix it. It entered via " +
          "@puppeteer/browsers 2.x; keep puppeteer at 25.x or later, where " +
          "@puppeteer/browsers 3.x uses modern-tar instead.",
      ).toEqual([]);
    });

    it("keeps @puppeteer/browsers on the 3.x line that dropped extract-zip", () => {
      const resolved = resolvedVersions("@puppeteer/browsers");
      expect(
        resolved.length,
        "expected at least one @puppeteer/browsers copy in the tree",
      ).toBeGreaterThan(0);
      const stale = resolved.filter((v) => !isAtLeast(v, [3, 0, 0]));
      expect(
        stale,
        `@puppeteer/browsers ${stale.join(", ")} is on the 2.x line, which depends on ` +
          "extract-zip. This is the arm that fails FIRST on a puppeteer downgrade, naming " +
          "the cause rather than the symptom.",
      ).toEqual([]);
    });

    /**
     * The advisory fix moved the Node floor, and `engines` is enforcement, not a wish.
     *
     * `puppeteer@25.8.0` declares `engines.node: ">=22.12.0"` (read off the installed
     * package). The root manifest declared `>=22.0.0`, so after this bump it certified a
     * Node band on which the dependency refuses to install — the same shape as #1213's
     * `engines.pnpm: ">=9.0.0"` certifying a pnpm that silently ignored every override.
     * CI is unaffected (`node-version: "22"` and `.nvmrc` both resolve to the latest 22.x),
     * which is exactly why this needs an assertion rather than a CI run to catch it.
     */
    it("declares an engines.node floor the bumped puppeteer can actually run on", () => {
      const PUPPETEER_NODE_FLOOR = [22, 12, 0];
      const engines = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).engines;
      expect(engines?.node, "package.json declares no engines.node").toBeTypeOf("string");
      expect(
        rangeMeetsFloor(engines.node, PUPPETEER_NODE_FLOOR),
        `engines.node is "${engines.node}", which admits a Node below ` +
          `${PUPPETEER_NODE_FLOOR.join(".")} — the floor puppeteer 25.x declares. On such a ` +
          "Node the install fails outright, so the manifest must not advertise it.",
      ).toBe(true);
    });
  });
});
