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
 * Regression guard for the TWENTY-EIGHT High/Critical advisories that held
 * `Dependency audit` red on `main` and on every PR from 2026-09-08 (#1363). All but one
 * were published in a single 2026-09-08 batch against an UNCHANGED lockfile, so nothing
 * in any PR caused them — a PR that genuinely introduced a vulnerable dependency looked
 * exactly like one that did not, which is the real cost the issue names.
 *
 *   GHSA-2xp9-vwfh-vxw4  next            CVSS 9.5  CRITICAL  fixed 16.3.3
 *   GHSA-p293-qw3h-jr36  next            CVSS 9.0  CRITICAL  fixed 16.3.3
 *   GHSA-rgj7-g3m4-5g8c  sharp           CVSS 8.9  fixed 0.35.4
 *   19 x @xmldom/xmldom                  CVSS 8.7  fixed 0.8.15 (8) / 0.9.12 (11)
 *   GHSA-2883-xcg3-v3hh  js-yaml         CVSS 7.5  fixed 4.3.2
 *   GHSA-535w-7cp7-47q4  multer          CVSS 7.5  fixed 2.3.0
 *   GHSA-qfvm-cv95-jqjf  multer          CVSS 7.5  fixed 2.3.0
 *   GHSA-wc9g-mqfw-jrwm  multer          CVSS 7.5  fixed 2.3.0
 *   GHSA-2x7j-588g-ccc2  nodemailer      CVSS 7.5  fixed 9.1.0
 *   GHSA-px8p-9vwx-vf98  fflate          CVSS 7.5  fixed 0.8.3   (see its block)
 *
 * `Dependency audit` is a LIVE OSV query, not a pinned snapshot, so it is an excellent
 * alarm and a poor regression test — delete one of these pins later and only this file
 * objects. `pnpm-overrides-repo.test.mjs` will not: its `MINIMUM_OVERRIDES` is a collapse
 * floor that a 40-override set clears with one pin missing. Same reasoning as
 * `pdfjs-overrides.test.mjs` (#1273) and `dependency-audit-1345-advisories.test.mjs`
 * (#1345), whose shape this file follows.
 *
 * ## Three targets are HIGHER than the advisory that opened the issue named
 *
 * Taking a `fixed` version verbatim is the bet #1240/#1273/#1291/#1324/#1345 each lost: a
 * fix version is only safe if no LATER advisory covers it. Re-queried against api.osv.dev
 * at bump time, 2026-09-20:
 *
 *   - `@xmldom/xmldom` 0.8.14 / 0.9.11 are the `fixed` events of GHSA-4w3w-2rp5-g8jm,
 *     GHSA-w2rr-34g9-rvrj and GHSA-g53g-w8rj-fmg7 — and are themselves inside the seven
 *     advisories fixed in 0.8.15 / 0.9.12. The floors here are the WIDEST per line.
 *   - `nodemailer` 9.1.0 closes the High, but is inside GHSA-8m3c-c648-2xjj
 *     (`introduced 0, fixed 9.1.1`, MODERATE). Moderate does not turn the gate red, so
 *     pinning to 9.1.0 would have closed this issue green on a known-vulnerable target.
 *
 * Every target was then re-verified to return ZERO vulns: 16.3.3/16.3.4/16.3.5, 0.35.4,
 * 0.8.15, 0.9.12, 0.9.13, 4.3.2, 2.3.0, 2.4.0, 9.1.1, 0.8.3.
 *
 * ## Every assertion reads the RESOLVED TREE, not the selector alone
 *
 * A test that re-reads an override string and checks it says what it says pins nothing.
 * The load-bearing arms scan `pnpm-lock.yaml` for what actually resolved, so they fail on
 * a deleted override, on a weakened target, AND on a new transitive consumer dragging a
 * vulnerable copy back in. Overrides are read from the LOCKFILE's top-level `overrides:`
 * block per #1213: that is what pnpm ACTUALLY applied, whereas a manifest `pnpm` field is
 * ignored under pnpm 11 with a warning and exit 0.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");

const effective = parseTopLevelOverrides(lockfile);

/**
 * Resolved versions of `name`, read from this file's lockfile.
 *
 * A thin binding over the shared helper so the call sites below stay terse. The helper
 * itself lives in `pnpm-overrides-core.mjs` — it used to be copied into this file, into
 * the #1345 file and into the #1324 file, and all three copies carried the same
 * fail-open hole (a prerelease `packages:` key was silently dropped, so a vulnerable
 * copy could make the guard go GREEN). See its doc comment for the proof.
 *
 * @param {string} name
 * @returns {string[]}
 */
function resolvedVersions(name) {
  return resolvedLockfileVersions(lockfile, name);
}

/**
 * True when `version` falls inside `[low, high)` — the shape of an OSV affected range.
 *
 * Needed because `@xmldom/xmldom` and `fflate` record a SEPARATE band per line, so
 * "at least the floor" is the wrong question: 0.8.15 is correct and 0.9.10 is a breach
 * even though 0.9.10 > 0.8.15. Asking "is it inside an affected band" is the question the
 * advisory actually answers.
 *
 * @param {string} version
 * @param {readonly [number, number, number]} low inclusive `introduced`
 * @param {readonly [number, number, number]} high exclusive `fixed`
 * @returns {boolean}
 */
function versionInBand(version, low, high) {
  return resolvedVersionMeetsFloor(version, low) && !resolvedVersionMeetsFloor(version, high);
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

/**
 * The semver range a workspace manifest declares for `name`, from any dependency block.
 *
 * `multer` and `nodemailer` each resolve exactly ONE copy and are DIRECT dependencies, so
 * they are fixed by a manifest bump rather than an override — there is no second consumer
 * for an override to catch. That makes the manifest the pin, and a lockfile-only
 * assertion would pass right through a reverted manifest until the next re-resolve.
 *
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

describe("the #1363 advisory set is closed in the resolved tree", () => {
  it("has an effective override set at all — a missing block means none were applied", () => {
    expect(
      effective,
      "pnpm-lock.yaml has no top-level `overrides:` block: pnpm applied NO overrides. " +
        "Under pnpm 11 this is what a package.json `pnpm` field produces (#1213), which " +
        "would silently disarm every pin below at once.",
    ).not.toBeNull();
  });

  describe("next — GHSA-2xp9-vwfh-vxw4 + GHSA-p293-qw3h-jr36, the only two CRITICALs", () => {
    const FIXED = /** @type {[number, number, number]} */ ([16, 3, 3]);

    it("targets 16.3.3 or above", () => {
      const entries = overridesFor("next");
      expect(entries, "no override governs next").not.toHaveLength(0);
      for (const [key, target] of entries) {
        const floor = /(\d+)\.(\d+)\.(\d+)/.exec(target);
        expect(floor, `override "${key}" target "${target}" carries no version`).not.toBeNull();
        expect(
          resolvedVersionMeetsFloor(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
          `override "${key}" targets "${target}". Both advisories record ` +
            "`introduced 16.0.0 -> fixed 16.3.3`: unauthenticated RCE in the Image " +
            "Optimization API on AVIF input (CVSS 9.5) and unauthenticated RCE on " +
            "Windows-hosted servers (CVSS 9.0).",
        ).toBe(true);
      }
    });

    it("moved its `<` bound with its floor (#1208)", () => {
      const entries = overridesFor("next");
      // A `for...of` over an empty list passes every assertion inside it, so deleting the
      // override would make this arm GREEN — the fail-open shape the memory index records
      // across #1168/#1178/#1180/#1192.
      expect(entries, "no override governs next").not.toHaveLength(0);
      for (const [key] of entries) {
        const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
        expect(
          ceiling,
          `override key "${key}" does not bound at 16.3.3. A \`<\`-bounded selector ` +
            "stops matching the moment a consumer's declared range clears the bound, so " +
            "leaving `<16.2.11` while raising the target to ^16.3.3 leaves the backstop " +
            "covering only the band already fixed — #1208's floor-not-ceiling defect, " +
            "which #1213, #1240 and #1345 each had to fix again.",
        ).toBe(FIXED.join("."));
      }
    });

    it("declares ^16.3.3 or above in ui/package.json, not just in the override", () => {
      const range = declaredRange("ui/package.json", "next");
      expect(range, "ui/package.json declares no `next` dependency").toBeDefined();
      const floor = /(\d+)\.(\d+)\.(\d+)/.exec(range);
      expect(floor, `ui/package.json next range "${range}" carries no version`).not.toBeNull();
      expect(
        resolvedVersionMeetsFloor(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
        `ui/package.json declares next "${range}". The override is a backstop for any ` +
          "OTHER consumer; the framework the UI actually builds against is named here.",
      ).toBe(true);
    });

    it("resolves NO next copy below 16.3.3", () => {
      const resolved = resolvedVersions("next");
      expect(
        resolved.length,
        "expected at least one next copy in the tree — a lookup that finds nothing reads " +
          "as 'no vulnerable version present', the fail-open shape this file guards against",
      ).toBeGreaterThan(0);
      const breaching = resolved.filter((v) => !resolvedVersionMeetsFloor(v, FIXED));
      expect(
        breaching,
        `lockfile resolves next ${breaching.join(", ")} below 16.3.3 — two unauthenticated ` +
          "RCEs, one of which (the AVIF Image Optimization path) is not Windows-specific.",
      ).toEqual([]);
    });
  });

  describe("@xmldom/xmldom — 19 High advisories across TWO separate affected bands", () => {
    // Per-line `fixed` events. 0.8.14 / 0.9.11 are the fix of three of the nineteen and
    // are covered by the other sixteen; these are the widest per line.
    const FIXED_08 = /** @type {[number, number, number]} */ ([0, 8, 15]);
    const FIXED_09 = /** @type {[number, number, number]} */ ([0, 9, 12]);
    const INTRO_08 = /** @type {[number, number, number]} */ ([0, 7, 0]);
    const INTRO_09 = /** @type {[number, number, number]} */ ([0, 9, 0]);

    it("governs BOTH bands — one selector cannot cover two disjoint lines", () => {
      const keys = overridesFor("@xmldom/xmldom").map(([key]) => key);
      expect(
        keys.some((key) => key.includes("<0.8.15")),
        `no override bounds the 0.8 line at 0.8.15; keys present: ${keys.join(", ") || "none"}. ` +
          "@node-saml/node-saml, xml-crypto, xml-encryption and mammoth all pin 0.8.13.",
      ).toBe(true);
      expect(
        keys.some((key) => key.includes("<0.9.12")),
        `no override bounds the 0.9 line at 0.9.12; keys present: ${keys.join(", ") || "none"}. ` +
          "officeparser@6.1.1 pins 0.9.10, and its own latest release still does.",
      ).toBe(true);
    });

    it("targets a version outside the band its own selector covers", () => {
      const entries = overridesFor("@xmldom/xmldom");
      expect(entries, "no override governs @xmldom/xmldom").not.toHaveLength(0);
      for (const [key, target] of entries) {
        const floor = /(\d+)\.(\d+)\.(\d+)/.exec(target);
        expect(floor, `override "${key}" target "${target}" carries no version`).not.toBeNull();
        const version = `${floor[1]}.${floor[2]}.${floor[3]}`;
        expect(
          versionInBand(version, INTRO_08, FIXED_08) || versionInBand(version, INTRO_09, FIXED_09),
          `override "${key}" targets "${target}", which is itself inside an affected band ` +
            "(0.7.0–0.8.15 or 0.9.0–0.9.12). Pinning to a version another advisory covers " +
            "is the bet #1240/#1273/#1291/#1324/#1345 each lost — here it would be 0.8.14 " +
            "or 0.9.11, which three of the nineteen advisories name as their fix.",
        ).toBe(false);
      }
    });

    it("declares ^0.8.15 or above in server/package.json for its own direct copy", () => {
      const range = declaredRange("server/package.json", "@xmldom/xmldom");
      expect(range, "server/package.json declares no @xmldom/xmldom dependency").toBeDefined();
      const floor = /(\d+)\.(\d+)\.(\d+)/.exec(range);
      expect(floor, `server range "${range}" carries no version`).not.toBeNull();
      expect(
        versionInBand(`${floor[1]}.${floor[2]}.${floor[3]}`, INTRO_08, FIXED_08),
        `server/package.json declares @xmldom/xmldom "${range}", inside the 0.7.0–0.8.15 ` +
          "affected band",
      ).toBe(false);
    });

    it("resolves NO @xmldom/xmldom copy inside either affected band", () => {
      const resolved = resolvedVersions("@xmldom/xmldom");
      expect(
        resolved.length,
        "expected at least one @xmldom/xmldom copy in the tree — a lookup that finds " +
          "nothing reads as 'no vulnerable version present'",
      ).toBeGreaterThan(0);
      const breaching = resolved.filter(
        (v) => versionInBand(v, INTRO_08, FIXED_08) || versionInBand(v, INTRO_09, FIXED_09),
      );
      expect(
        breaching,
        `lockfile resolves @xmldom/xmldom ${breaching.join(", ")} inside an affected band. ` +
          "This is the arm that matters most here: the tree carried TWO copies on TWO " +
          "lines, 0.8.13 (SAML signature verification, .docx parsing) and 0.9.10 " +
          "(officeparser). Checking only that every copy is 'at least 0.8.15' would pass " +
          "0.9.10 — a breach — because 0.9.10 > 0.8.15.",
      ).toEqual([]);
    });
  });

  describe("sharp — GHSA-rgj7-g3m4-5g8c (CVSS 8.9), fixed 0.35.4", () => {
    const FIXED = /** @type {[number, number, number]} */ ([0, 35, 4]);

    it("targets 0.35.4 or above", () => {
      const entries = overridesFor("sharp");
      expect(entries, "no override governs sharp").not.toHaveLength(0);
      for (const [key, target] of entries) {
        const floor = /(\d+)\.(\d+)\.(\d+)/.exec(target);
        expect(floor, `override "${key}" target "${target}" carries no version`).not.toBeNull();
        expect(
          resolvedVersionMeetsFloor(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
          `override "${key}" targets "${target}"; OSV records \`introduced 0 -> ` +
            "fixed 0.35.4` for a heap buffer overflow in libvips' TIFF loader",
        ).toBe(true);
      }
    });

    it("moved its `<` bound with its floor (#1208)", () => {
      const entries = overridesFor("sharp");
      expect(entries, "no override governs sharp").not.toHaveLength(0);
      for (const [key] of entries) {
        const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
        expect(
          ceiling,
          `override key "${key}" does not bound at 0.35.4. This line shipped as ` +
            "`sharp@<0.35.0: ^0.35.0`, which reaches a consumer only when its declared " +
            "RANGE intersects `<0.35.0`. Measured by installing `sharp@<0.35.0: 0.35.2`: " +
            "@huggingface/transformers (^0.34.1) was forced to 0.35.2 while next's own " +
            "`sharp: ^0.35.4` resolved untouched — a second copy the old selector never " +
            "governed. `<0.35.4` is the advisory's `fixed` event and covers the whole " +
            "affected band.",
        ).toBe(FIXED.join("."));
      }
    });

    it("resolves NO sharp copy below 0.35.4", () => {
      const resolved = resolvedVersions("sharp");
      expect(resolved.length, "expected at least one sharp copy in the tree").toBeGreaterThan(0);
      const breaching = resolved.filter((v) => !resolvedVersionMeetsFloor(v, FIXED));
      expect(
        breaching,
        `lockfile resolves sharp ${breaching.join(", ")} below 0.35.4. It enters via ` +
          "@huggingface/transformers, whose latest release still declares ^0.34/^0.35 — " +
          "so there is no upstream bump to wait for and the override is the fix.",
      ).toEqual([]);
    });
  });

  describe("js-yaml — GHSA-2883-xcg3-v3hh (CVSS 7.5), fixed 4.3.2", () => {
    const FIXED = /** @type {[number, number, number]} */ ([4, 3, 2]);

    it("targets 4.3.2 or above — 4.3.1 was #1291's fix and did not hold", () => {
      const entries = overridesFor("js-yaml");
      expect(entries, "no override governs js-yaml").not.toHaveLength(0);
      for (const [key, target] of entries) {
        const floor = /(\d+)\.(\d+)\.(\d+)/.exec(target);
        expect(floor, `override "${key}" target "${target}" carries no version`).not.toBeNull();
        expect(
          resolvedVersionMeetsFloor(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
          `override "${key}" targets "${target}"; OSV records \`introduced 4.0.0 -> ` +
            "fixed 4.3.2` for unbounded memory in anchor expansion. The 4.3.1 this line " +
            "used to pin to was itself chosen as GHSA-5p4m-2wfm-xmqj's fix.",
        ).toBe(true);
      }
    });

    it("stays inside the 4.x major — 5.x is a separate, unbuildable change", () => {
      const entries = overridesFor("js-yaml");
      expect(entries, "no override governs js-yaml").not.toHaveLength(0);
      for (const [, target] of entries) {
        const major = /(\d+)\.\d+\.\d+/.exec(target)?.[1];
        expect(
          major,
          `js-yaml override targets "${target}" outside the 4.x line. PR #1203's 4 -> 5 ` +
            "bump does not build (`'js-yaml' does not provide an export named 'default'`) " +
            "and is separate work; a patch closes this advisory.",
        ).toBe("4");
      }
    });

    it("resolves NO js-yaml 4.x copy below 4.3.2", () => {
      const resolved = resolvedVersions("js-yaml");
      expect(resolved.length, "expected at least one js-yaml copy in the tree").toBeGreaterThan(0);
      const breaching = resolved.filter(
        (v) => v.startsWith("4.") && !resolvedVersionMeetsFloor(v, FIXED),
      );
      expect(
        breaching,
        `lockfile resolves js-yaml ${breaching.join(", ")} below 4.3.2 — a billion-laughs ` +
          "DoS from untrusted YAML, which the server parses on the ingest path.",
      ).toEqual([]);
    });
  });

  describe("multer — three High advisories, all fixed 2.3.0", () => {
    // No override: multer is a DIRECT dependency of server/ with exactly one copy in the
    // tree, so the manifest range IS the pin. Both arms below are load-bearing.
    const FIXED = /** @type {[number, number, number]} */ ([2, 3, 0]);

    it("declares ^2.3.0 or above in server/package.json", () => {
      const range = declaredRange("server/package.json", "multer");
      expect(range, "server/package.json declares no multer dependency").toBeDefined();
      const floor = /(\d+)\.(\d+)\.(\d+)/.exec(range);
      expect(floor, `server multer range "${range}" carries no version`).not.toBeNull();
      expect(
        resolvedVersionMeetsFloor(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
        `server/package.json declares multer "${range}". GHSA-535w-7cp7-47q4, ` +
          "GHSA-qfvm-cv95-jqjf and GHSA-wc9g-mqfw-jrwm are each fixed in 2.3.0 — " +
          "unhandled exceptions from a malformed multipart body, i.e. remote process " +
          "crash on the upload endpoint.",
      ).toBe(true);
    });

    it("resolves NO multer copy below 2.3.0", () => {
      const resolved = resolvedVersions("multer");
      expect(resolved.length, "expected at least one multer copy in the tree").toBeGreaterThan(0);
      const breaching = resolved.filter((v) => !resolvedVersionMeetsFloor(v, FIXED));
      expect(breaching, `lockfile resolves multer ${breaching.join(", ")} below 2.3.0`).toEqual([]);
    });
  });

  describe("nodemailer — GHSA-2x7j-588g-ccc2, and why the floor is 9.1.1 not 9.1.0", () => {
    const FIXED = /** @type {[number, number, number]} */ ([9, 1, 1]);

    it("declares ^9.1.1 or above in server/package.json, not the 9.1.0 the High names", () => {
      const range = declaredRange("server/package.json", "nodemailer");
      expect(range, "server/package.json declares no nodemailer dependency").toBeDefined();
      const floor = /(\d+)\.(\d+)\.(\d+)/.exec(range);
      expect(floor, `server nodemailer range "${range}" carries no version`).not.toBeNull();
      expect(
        resolvedVersionMeetsFloor(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
        `server/package.json declares nodemailer "${range}". GHSA-2x7j-588g-ccc2 ` +
          "(CVSS 7.5) is fixed in 9.1.0, but 9.1.0 is itself inside GHSA-8m3c-c648-2xjj " +
          "(`introduced 0, fixed 9.1.1`). That one is MODERATE, so it would not turn " +
          "`Dependency audit` red — pinning to 9.1.0 would have closed this issue with a " +
          "green gate and a known-vulnerable target.",
      ).toBe(true);
    });

    it("stays inside the 9.x major — 10.x is a separate change", () => {
      const range = declaredRange("server/package.json", "nodemailer");
      expect(
        /(\d+)\.\d+\.\d+/.exec(range)?.[1],
        `nodemailer is pinned to "${range}". This arm holds the range inside 9.x: 10.x is a ` +
          "major bump with its own breaking changes and belongs in its own PR, not smuggled " +
          "in under an advisory fix.",
      ).toBe("9");
    });

    it("resolves NO nodemailer copy below 9.1.1", () => {
      const resolved = resolvedVersions("nodemailer");
      expect(resolved.length, "expected at least one nodemailer copy in the tree").toBeGreaterThan(
        0,
      );
      const breaching = resolved.filter((v) => !resolvedVersionMeetsFloor(v, FIXED));
      expect(breaching, `lockfile resolves nodemailer ${breaching.join(", ")} below 9.1.1`).toEqual(
        [],
      );
    });
  });

  /**
   * NOT in the issue's `pnpm audit` snapshot — found by running the CI gate's OWN scan
   * (osv-scanner + the threshold script inlined in .github/workflows/sast.yml) against
   * the branch, which is the only way to verify AC1. OSV records
   * `database_specific.severity: MODERATE` for it, but the gate discriminates on the
   * GROUP's CVSS `max_severity`, and the CVSS:3.1 vector scores 7.5. So it breaches the
   * 7.0 threshold, it is one of the 28 findings holding the gate red, and closing only
   * the 27 the issue lists would have left `Dependency audit` red having "done the
   * upgrade" — the failure mode this whole issue exists to end.
   */
  describe("fflate — GHSA-px8p-9vwx-vf98, the advisory the issue's snapshot missed", () => {
    // OSV records a band per minor; only the 0.8 line is in this tree.
    const INTRO = /** @type {[number, number, number]} */ ([0, 8, 0]);
    const FIXED = /** @type {[number, number, number]} */ ([0, 8, 3]);

    it("targets a version outside the 0.8 affected band", () => {
      const entries = overridesFor("fflate");
      expect(entries, "no override governs fflate").not.toHaveLength(0);
      for (const [key, target] of entries) {
        const floor = /(\d+)\.(\d+)\.(\d+)/.exec(target);
        expect(floor, `override "${key}" target "${target}" carries no version`).not.toBeNull();
        expect(
          versionInBand(`${floor[1]}.${floor[2]}.${floor[3]}`, INTRO, FIXED),
          `override "${key}" targets "${target}", inside \`introduced 0.8.0 -> fixed 0.8.3\``,
        ).toBe(false);
      }
    });

    it("bounds the selector at the advisory's `fixed` event, not above it (#1208)", () => {
      const entries = overridesFor("fflate");
      expect(entries, "no override governs fflate").not.toHaveLength(0);
      for (const [key] of entries) {
        const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
        expect(
          ceiling,
          `override key "${key}" carries no explicit \`<\` upper bound, so it matches ` +
            "every version above its floor — including the 0.4–0.7 lines this advisory " +
            "bands separately and which are not in this tree.",
        ).toBe(FIXED.join("."));
      }
    });

    it("resolves NO fflate copy inside the 0.8 affected band", () => {
      const resolved = resolvedVersions("fflate");
      expect(resolved.length, "expected at least one fflate copy in the tree").toBeGreaterThan(0);
      const breaching = resolved.filter((v) => versionInBand(v, INTRO, FIXED));
      expect(
        breaching,
        `lockfile resolves fflate ${breaching.join(", ")} inside 0.8.0–0.8.3 — an ` +
          "uninterruptible infinite loop inflating a malformed stream. Sole consumer is " +
          "officeparser@6.1.1, reached from server/src/lib/documents/parsers.ts:290-294 " +
          "on the `pptx` branch — a ZIP, which is what fflate inflates. (.docx goes to " +
          "mammoth and .xlsx to exceljs, so neither reaches fflate.)",
      ).toEqual([]);
    });
  });
});
