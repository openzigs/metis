import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTopLevelOverrides } from "./pnpm-overrides-core.mjs";

/**
 * Regression guard for the SEVEN High advisories that held `Dependency audit` red on
 * `main` and on every PR from 2026-09-01 (#1345). Three are the ones the issue names;
 * the four fast-uri entries are a second batch, published while this branch was being
 * written, that AC1 could not be met without — see that `describe` block for the whole
 * story.
 *
 *   GHSA-73wf-gq98-2v4g  browserslist  CVSS 7.5  introduced 0  fixed 4.28.7
 *   GHSA-c83g-rgw3-j3cx  browserslist  CVSS 7.5  introduced 0  fixed 4.28.7
 *   GHSA-3f6p-5ww8-9rcr  mysql2        CVSS 8.2  introduced 0  fixed 3.22.0
 *
 * Nothing in any PR caused it: the lockfile was unchanged and all three advisories
 * published ~7 hours after the last green run. `Dependency audit` is a LIVE OSV query,
 * not a pinned snapshot, so it is an excellent alarm and a poor regression test — delete
 * one of these overrides later and only this file objects. `pnpm-overrides-repo.test.mjs`
 * will not: its `MINIMUM_OVERRIDES` is a collapse floor that a 30-override set clears
 * with one pin missing. Same reasoning as `pdfjs-overrides.test.mjs` (#1273) and
 * `dependency-audit-1324-advisories.test.mjs` (#1324), whose shape this file follows.
 *
 * ## mysql2's floor is 3.23.1, NOT the 3.22.0 the issue asked for
 *
 * The issue's acceptance criteria say `mysql2 >= 3.22.0` — the `fixed` event of
 * GHSA-3f6p-5ww8-9rcr. Taking that verbatim is the bet #1240, #1273, #1291 and #1324
 * each lost: a fix version is only safe if no LATER advisory covers it. Re-queried at
 * bump time, `api.osv.dev` returns GHSA-rgwj-5xj2-c3m3 for `mysql2@3.22.0` (unbounded
 * zlib inflate in the compressed protocol handler, `introduced 0`, `fixed 3.23.1`,
 * published 2026-08-31 — the day BEFORE the advisory this issue was filed for). It is
 * MODERATE, so it would not have turned `Dependency audit` red on its own; pinning to
 * 3.22.0 would therefore have closed the issue with a *known-vulnerable* target and a
 * green gate. 3.23.1 closes both, and 3.23.1 / 3.24.2 each return ZERO vulns.
 *
 * ## Every assertion reads the RESOLVED TREE, not the selector alone
 *
 * A test that re-reads an override string and checks it says what it says pins nothing.
 * The load-bearing arms scan `pnpm-lock.yaml` for what actually resolved, so they fail on
 * a deleted override, on a weakened target, AND on a new transitive consumer dragging a
 * vulnerable copy back in. Overrides are read from the LOCKFILE's top-level `overrides:`
 * block per #1213: that is what pnpm applied, whereas a manifest `pnpm` field is ignored
 * under pnpm 11 with a warning and exit 0.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");

const effective = parseTopLevelOverrides(lockfile);

/**
 * Every version of `name` the lockfile actually resolves.
 *
 * Matches the two-space-indented `name@x.y.z:` package/snapshot keys — the only place a
 * resolved version appears unqualified. The optional leading quote handles pnpm's scoped
 * form; the anchored literal regex excludes selector lines (`mysql2@<3.23.1: ^3.23.1`)
 * and peer-suffixed snapshot keys (`mysql2@3.24.2(@types/node@25.6.0):`), whose bare
 * counterpart is always present in `packages:` anyway. Copied deliberately from
 * `dependency-audit-1324-advisories.test.mjs`, including its reason for prefix matching
 * over an interpolated `new RegExp` (Semgrep `detect-non-literal-regexp`).
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
    const match = /^(\d+\.\d+\.\d+)'?:$/.exec(rest);
    if (match) versions.add(match[1]);
  }
  return [...versions];
}

/**
 * Compare a dotted version against a `[major, minor, patch]` triple.
 *
 * `isAtLeast` from `pnpm-overrides-core.mjs` reads the FLOOR of a range and is the right
 * tool for an override target. It is the wrong tool for a resolved version, because
 * `floorOf` takes the first version-shaped substring it finds — fine for `^4.28.8`, but
 * it silently accepts anything. A resolved version is an exact triple, so compare it as
 * one and refuse a malformed input rather than letting it read as 0.0.0 or as a pass.
 *
 * @param {string} version
 * @param {readonly [number, number, number]} floor
 * @returns {boolean}
 */
function versionAtLeast(version, floor) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not an exact resolved version: ${version}`);
  const triple = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    if (triple[i] !== floor[i]) return triple[i] > floor[i];
  }
  return true;
}

/**
 * Override entries governing `name`, DERIVED from what pnpm applied rather than compared
 * against a hardcoded key — #1273's panel caught an arm that compared one literal in the
 * test against another literal in the test, unfalsifiable by any edit to the real config.
 *
 * @param {string} name
 * @returns {Array<[string, string]>}
 */
function overridesFor(name) {
  return [...(effective?.entries() ?? [])].filter(
    ([key]) => key === name || key.startsWith(`${name}@`),
  );
}

describe("the #1345 advisory set is closed in the resolved tree", () => {
  it("has an effective override set at all — a missing block means none were applied", () => {
    expect(
      effective,
      "pnpm-lock.yaml has no top-level `overrides:` block: pnpm applied NO overrides. " +
        "Under pnpm 11 this is what a package.json `pnpm` field produces (#1213), which " +
        "is exactly the inert fix this issue's original `Suggested fix` prescribed.",
    ).not.toBeNull();
  });

  describe("browserslist — GHSA-73wf-gq98-2v4g + GHSA-c83g-rgw3-j3cx, both fixed in 4.28.7", () => {
    const FIXED = /** @type {[number, number, number]} */ ([4, 28, 7]);

    it("targets 4.28.7 or above", () => {
      const entries = overridesFor("browserslist");
      expect(
        entries,
        "no override governs browserslist, so @babel/helper-compilation-targets' copy " +
          "is unpinned",
      ).not.toHaveLength(0);
      for (const [key, target] of entries) {
        const floor = /(\d+)\.(\d+)\.(\d+)/.exec(target);
        expect(floor, `override "${key}" target "${target}" carries no version`).not.toBeNull();
        expect(
          versionAtLeast(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
          `override "${key}" targets "${target}"; both advisories record ` +
            "`introduced 0 -> fixed 4.28.7`, so the whole line below 4.28.7 is affected",
        ).toBe(true);
      }
    });

    it("bounds the selector at the advisory's `fixed` event, not above it (#1208)", () => {
      const entries = overridesFor("browserslist");
      // A `for...of` over an empty list passes every assertion inside it. Without this
      // line, DELETING the override makes this arm go GREEN — the exact fail-open shape
      // the memory index records across #1168/#1178/#1180/#1192. Measured: the first
      // draft of this file passed both ceiling arms against the unfixed lockfile.
      expect(entries, "no override governs browserslist").not.toHaveLength(0);
      for (const [key] of entries) {
        const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
        expect(
          ceiling,
          `override key "${key}" carries no explicit \`<\` upper bound, so it matches ` +
            "every version above its floor — including majors these advisories say " +
            "nothing about. Both record `introduced 0`, so the band is exactly `<4.28.7`.",
        ).toBe(FIXED.join("."));
      }
    });

    it("resolves NO browserslist copy below 4.28.7", () => {
      const resolved = resolvedVersions("browserslist");
      expect(
        resolved.length,
        "expected at least one browserslist copy in the tree — a lookup that finds " +
          "nothing reads as 'no vulnerable version present', the fail-open shape this " +
          "file exists to guard against",
      ).toBeGreaterThan(0);
      const breaching = resolved.filter((v) => !versionAtLeast(v, FIXED));
      expect(
        breaching,
        `lockfile resolves browserslist ${breaching.join(", ")} below 4.28.7 — a crash / ` +
          "prototype write via an untrusted browserslist-stats.json (GHSA-73wf-gq98-2v4g) " +
          "and unbounded cache growth to OOM (GHSA-c83g-rgw3-j3cx). It enters via " +
          "@babel/helper-compilation-targets and update-browserslist-db.",
      ).toEqual([]);
    });
  });

  describe("mysql2 — GHSA-3f6p-5ww8-9rcr (CVSS 8.2) and GHSA-rgwj-5xj2-c3m3", () => {
    // The HIGHER of the two `fixed` events. See the file header: 3.22.0 closes only the
    // High one and is itself covered by GHSA-rgwj-5xj2-c3m3.
    const FIXED = /** @type {[number, number, number]} */ ([3, 23, 1]);

    it("targets 3.23.1 or above, not the 3.22.0 the advisory that opened #1345 named", () => {
      const entries = overridesFor("mysql2");
      expect(entries, "no override governs mysql2, so prisma's copy is unpinned").not.toHaveLength(
        0,
      );
      for (const [key, target] of entries) {
        const floor = /(\d+)\.(\d+)\.(\d+)/.exec(target);
        expect(floor, `override "${key}" target "${target}" carries no version`).not.toBeNull();
        expect(
          versionAtLeast(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
          `override "${key}" targets "${target}". GHSA-3f6p-5ww8-9rcr (auth-plugin ` +
            "downgrade to mysql_clear_password, plaintext credential leak) is fixed in " +
            "3.22.0, but 3.22.0 is itself inside GHSA-rgwj-5xj2-c3m3 (`introduced 0 -> " +
            "fixed 3.23.1`). Pinning to a fix version another advisory already covers is " +
            "the bet #1240/#1273/#1291/#1324 each lost.",
        ).toBe(true);
      }
    });

    it("bounds the selector at the widest `fixed` event, not above it (#1208)", () => {
      const entries = overridesFor("mysql2");
      // See the browserslist arm above: an empty loop body is a vacuous pass.
      expect(entries, "no override governs mysql2").not.toHaveLength(0);
      for (const [key] of entries) {
        const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
        expect(
          ceiling,
          `override key "${key}" carries no explicit \`<\` upper bound. Both advisories ` +
            "record `introduced 0`; the wider band is GHSA-rgwj-5xj2-c3m3's, so the " +
            "selector is exactly `<3.23.1`.",
        ).toBe(FIXED.join("."));
      }
    });

    it("resolves NO mysql2 copy below 3.23.1 — BOTH copies moved, not just the manifest's", () => {
      const resolved = resolvedVersions("mysql2");
      expect(resolved.length, "expected at least one mysql2 copy in the tree").toBeGreaterThan(0);
      const breaching = resolved.filter((v) => !versionAtLeast(v, FIXED));
      expect(
        breaching,
        `lockfile resolves mysql2 ${breaching.join(", ")} below 3.23.1. This is the arm ` +
          "the issue called out as mattering most: the tree carried TWO copies — the " +
          "patched 3.22.3 that `server/package.json` asks for AND a vulnerable 3.15.3 " +
          "pinned by prisma's driver-adapter fan-out. Verifying by the manifest instead " +
          "of by resolution would have missed the second one entirely.",
      ).toEqual([]);
    });
  });

  /**
   * NOT one of #1345's three advisories — found by running the CI gate's own OSV scan
   * locally to verify AC1 ("`Dependency audit` passes on `main` with no High or Critical
   * findings"). Closing browserslist and mysql2 left the gate STILL RED on four fast-uri
   * advisories published 2026-09-02T15:41-15:44Z, hours before this branch was cut, and
   * red on `origin/main` in the same way. AC1 is unmeetable without them, so they are
   * closed here rather than deferred to a second issue that would land on a red gate.
   *
   * This is the fourth recurrence of the same bet: `pnpm-workspace.yaml`'s fast-uri
   * comment says in so many words that pinning to a version another advisory later covers
   * is what #1211/#1240/#1273 each lost — and the very line carrying that warning was
   * pinned at `^3.1.5`, which all four of these advisories cover.
   */
  describe("fast-uri — the 2026-09-02 batch that AC1 could not be met without", () => {
    // All four record `fixed 3.1.6` on the 3.x line; the 2.x and 4.x ranges are not in
    // this tree. 3.1.6 (published 2026-08-23) and 3.1.7 both return zero vulns on
    // api.osv.dev, re-read 2026-09-02.
    const FIXED = /** @type {[number, number, number]} */ ([3, 1, 6]);

    it("targets 3.1.6 or above", () => {
      const entries = overridesFor("fast-uri");
      expect(entries, "no override governs fast-uri").not.toHaveLength(0);
      for (const [key, target] of entries) {
        const floor = /(\d+)\.(\d+)\.(\d+)/.exec(target);
        expect(floor, `override "${key}" target "${target}" carries no version`).not.toBeNull();
        expect(
          versionAtLeast(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
          `override "${key}" targets "${target}"; GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, ` +
            "GHSA-fph4-wmhf-6fwf and GHSA-jqff-g426-hqxp are each fixed in 3.1.6 on the " +
            "3.x line, and each covers the 3.1.5 this override used to pin to",
        ).toBe(true);
      }
    });

    it("moved its `<` bound with its floor — the failure its own comment warns about", () => {
      const entries = overridesFor("fast-uri");
      expect(entries, "no override governs fast-uri").not.toHaveLength(0);
      for (const [key] of entries) {
        const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
        expect(
          ceiling,
          `override key "${key}" does not bound at 3.1.6. A \`<\`-bounded selector stops ` +
            "matching the moment the tree resolves its own floor, so leaving `<3.1.5` here " +
            "while raising the target to ^3.1.6 silently disarms the override — #1208's " +
            "floor-not-ceiling defect, which #1213 and #1240 each had to fix again.",
        ).toBe(FIXED.join("."));
      }
    });

    it("resolves NO fast-uri copy inside the 3.x affected band", () => {
      const resolved = resolvedVersions("fast-uri");
      expect(resolved.length, "expected at least one fast-uri copy in the tree").toBeGreaterThan(0);
      const breaching = resolved.filter((v) => !versionAtLeast(v, FIXED));
      expect(
        breaching,
        `lockfile resolves fast-uri ${breaching.join(", ")} below 3.1.6 — SSRF via ` +
          "malformed IPv6 normalization and repeated hostname percent-decoding, plus host " +
          "confusion via percent-encoded scheme normalization and skipped IDN " +
          "canonicalization. It reaches the tree through ajv.",
      ).toEqual([]);
    });
  });
});
