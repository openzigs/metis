import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { floorOf, isAtLeast, parseTopLevelOverrides } from "./pnpm-overrides-core.mjs";

/**
 * Regression guard for GHSA-hq66-cqwq-w95j (#1273).
 *
 * `pdfjs-dist` 5.6.83 through 6.2.107 executes ARBITRARY JAVASCRIPT when it opens a
 * malicious PDF (CVSS 8.6). METIS ingests user-uploaded PDFs, and the vulnerable copy
 * was on the upload path, so this is the highest-severity advisory this repo has had.
 *
 * ## Why the tree needs a guard at all, when `Dependency audit` already exists
 *
 * That gate is a LIVE OSV FEED. It goes red while the advisory is published and current,
 * which makes it a fine alarm and a poor regression test: delete this override a year
 * from now, when the feed has moved on or the entry is re-scoped, and nothing local
 * objects. #1273's adversarial panel measured exactly that — with the override deleted
 * from BOTH pnpm-workspace.yaml and pnpm-lock.yaml the repo guard still returned ok,
 * because `MINIMUM_OVERRIDES = 20` is a collapse floor and 27 overrides clear it, and
 * weakening the target to a still-vulnerable `^5.6.83` passed too.
 *
 * ## The advisory band is a REGRESSION WINDOW, not "older is worse"
 *
 * OSV records `introduced 5.6.83, fixed 6.2.108`. The tree carries TWO copies and only
 * one is in the band:
 *
 *   pdf-parse@2.4.5     -> pdfjs-dist 5.4.296   BELOW the band, unaffected
 *   officeparser@6.1.1  -> pdfjs-dist 6.2.108   was 5.6.205, the breach
 *
 * So the override is deliberately scoped to the band and pdf-parse's copy must NOT be
 * dragged along. Both facts are asserted below: a well-meaning "just force everything to
 * 6.x" edit is a behaviour change, not a tidy-up.
 *
 * ## These assertions read the RESOLVED TREE, not just the selector
 *
 * A test that re-reads the override string and checks it says what it says pins nothing.
 * The load-bearing assertion is the last one: NO copy anywhere in the lockfile may sit
 * inside the advisory's band. That fails on a deleted override, on a weakened target,
 * and on a new transitive consumer pulling a fresh 5.6.x/6.0.x — none of which the
 * selector-shaped assertions would catch on their own.
 *
 * Per #1213 the overrides are sourced from the LOCKFILE's top-level `overrides:` block —
 * what pnpm actually applied — never from a manifest's `pnpm` field, which pnpm 11
 * ignores with a warning and exit 0.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");

/** OSV's `introduced` and `fixed` events for GHSA-hq66-cqwq-w95j. */
const INTRODUCED = [5, 6, 83];
const FIXED = [6, 2, 108];

const effective = parseTopLevelOverrides(lockfile);

/**
 * Every override key that governs `pdfjs-dist`, DERIVED from what pnpm actually applied.
 *
 * Deliberately not a hardcoded key string. An assertion that compares one literal in this
 * file against another literal in this file cannot be falsified by any edit to the real
 * configuration — #1273's second-round panel caught exactly that: the ceiling arm below
 * originally compared two constants declared here, so removing the selector's `<` bound in
 * the lockfile (the precise #1208 defect the arm claims to guard) left it green.
 * Deriving the key means a rename, a widened band or a dropped bound all reach the
 * assertions.
 */
function pdfjsOverrides() {
  return [...(effective?.entries() ?? [])].filter(([key]) => /^pdfjs-dist(@|$)/.test(key));
}

/** Every `pdfjs-dist` version the lockfile actually resolves. */
function resolvedVersions() {
  return [...lockfile.matchAll(/^ {2}pdfjs-dist@(\d+\.\d+\.\d+):/gm)].map((m) => m[1]);
}

function isInAdvisoryBand(version) {
  return isAtLeast(version, INTRODUCED) && !isAtLeast(version, FIXED);
}

describe("pdfjs-dist overrides (GHSA-hq66-cqwq-w95j)", () => {
  it("has an effective override set at all — a missing block means none were applied", () => {
    expect(
      effective,
      "pnpm-lock.yaml has no top-level `overrides:` block: pnpm applied NO overrides. " +
        "Under pnpm 11 this is what a package.json `pnpm` field produces (#1213).",
    ).not.toBeNull();
  });

  it("applies exactly one override governing pdfjs-dist", () => {
    const entries = pdfjsOverrides();
    expect(
      entries.map(([key]) => key),
      "the lockfile must apply exactly one override governing pdfjs-dist. Zero means the " +
        "advisory band is unpinned; more than one means two selectors can disagree about " +
        "the same package.",
    ).toHaveLength(1);
  });

  it("targets a version at or above the 6.2.108 fixed floor", () => {
    for (const [key, target] of pdfjsOverrides()) {
      expect(
        isAtLeast(target, FIXED),
        `override "${key}" targets "${target}"; GHSA-hq66-cqwq-w95j is fixed in 6.2.108. ` +
          "A target inside the band re-breaches while still looking like a pin.",
      ).toBe(true);
    }
  });

  it("moves the selector's UPPER bound with its floor (#1208, recurred in #1213)", () => {
    // Read the bound off the KEY THE LOCKFILE CARRIES, never off a constant in this file:
    // an unbounded `pdfjs-dist@>=5.6.83` selector keeps matching every future major and
    // pins it to this advisory's fix, and a bound left behind when the floor moves stops
    // matching the moment the tree resolves the new floor. Both must be reachable here.
    for (const [key, target] of pdfjsOverrides()) {
      const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
      expect(
        ceiling,
        `override key "${key}" carries no explicit \`<\` upper bound, so it matches every ` +
          "version above its floor — including majors this advisory says nothing about",
      ).toBeDefined();
      expect(
        ceiling,
        `override key "${key}" is bounded at "${ceiling}", but the advisory is fixed in ` +
          `${FIXED.join(".")}; the ceiling must track the advisory's \`fixed\` event so the ` +
          "band the selector covers is exactly the band that is vulnerable",
      ).toBe(FIXED.join("."));
      // And the two must stay coupled: the target has to satisfy the bound it replaces.
      expect(
        isAtLeast(target, floorOf(`${ceiling}`)),
        `override "${key}" targets "${target}", below its own ceiling "${ceiling}" — the ` +
          "selector would keep matching its own result",
      ).toBe(true);
    }
  });

  it("resolves NO pdfjs-dist copy inside the advisory band", () => {
    const resolved = resolvedVersions();
    expect(resolved.length, "expected at least one pdfjs-dist copy in the tree").toBeGreaterThan(0);
    const breaching = resolved.filter(isInAdvisoryBand);
    expect(
      breaching,
      `lockfile resolves pdfjs-dist ${breaching.join(", ")} inside [5.6.83, 6.2.108) — ` +
        "arbitrary JS execution on opening a malicious PDF, reachable from document upload",
    ).toEqual([]);
  });

  it("does not reach BELOW the advisory band and drag unaffected copies across a major", () => {
    // Scoping is the point: `pdf-parse` resolves 5.4.296, which is below `introduced` and
    // therefore unaffected. Widening the selector to all of 5.x would force it across a
    // major for no security benefit — the hazard this asserts against.
    //
    // Assert that on the SELECTOR, not on the tree. An earlier draft required a below-band
    // copy to still EXIST, which is not a security invariant: any future pdf-parse bump
    // landing its pdfjs at or above 5.6.83 would empty that set and turn the suite red on a
    // strictly SAFER tree. #1273's second-round panel caught that as over-blocking. The
    // selector's floor is the thing that must not move down; what the tree happens to
    // contain below the band is not this guard's business.
    for (const [key] of pdfjsOverrides()) {
      const floor = /@>=\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
      expect(
        floor,
        `override key "${key}" carries no explicit \`>=\` lower bound, so it matches every ` +
          "version below the band too — including copies the advisory does not cover",
      ).toBeDefined();
      expect(
        floor,
        `override key "${key}" starts at "${floor}", but the advisory is introduced in ` +
          `${INTRODUCED.join(".")}; a lower floor forces unaffected consumers across a major`,
      ).toBe(INTRODUCED.join("."));
    }
  });
});
