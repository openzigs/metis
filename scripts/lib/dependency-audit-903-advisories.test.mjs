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
 * Regression guard for the TEN High/Critical advisories, published 2026-10-05/06 against
 * an unchanged lockfile, that turned `Dependency audit` red on every PR (#903):
 *
 *   GHSA-6qxp-vccf-f47h  @modelcontextprotocol/sdk  CVSS 7.5  fixed 1.31.0   direct (server)
 *   GHSA-x6jw-m9v5-85vh  simple-git                 CVSS 9.2  fixed 4.0.1    direct (server)
 *   GHSA-858h-whjf-mvg5  simple-git                 CVSS 8.1  fixed 4.0.0
 *   GHSA-g4wm-2vf7-vfgr  simple-git                 CVSS 8.1  fixed 4.0.0
 *   GHSA-v5rq-49vh-5v5c  @simple-git/argv-parser    CVSS 9.2  fixed 2.0.1    via simple-git
 *   GHSA-jqcg-44mw-7w3h  proxy-addr                 CVSS 9.1  fixed 2.0.8    via express
 *   GHSA-p6vx-979v-rg4c  seroval                    CVSS 9.8  fixed 1.6.2    via solid-js
 *   GHSA-jp82-f5mq-hwhp  seroval                    CVSS 7.5  fixed 1.6.3    via solid-js
 *   GHSA-wq5f-xc86-pv6w  sharp                      CVSS 8.9  fixed 0.35.5   via transformers, next
 *   GHSA-68fv-2mgg-jv7q  source-map-js              CVSS 8.7  fixed 1.2.2    via postcss et al.
 *
 * Same shape and reasoning as `dependency-audit-1363-advisories.test.mjs`: the audit is a
 * live OSV query, so it alarms well and regresses poorly — this file is what objects when
 * a pin is later deleted or weakened. Every arm reads the RESOLVED lockfile (and, for the
 * two direct dependencies, the declaring manifest), never an override string alone.
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

/**
 * Asserts every resolved copy of `name` is at or above `fixed`. Fails on an EMPTY result
 * too: a lookup that finds nothing would otherwise read as "no vulnerable copy present".
 *
 * @param {string} name
 * @param {Triple} fixed
 * @param {string} why
 */
function expectNoCopyBelow(name, fixed, why) {
  const resolved = resolvedLockfileVersions(lockfile, name);
  expect(resolved.length, `expected at least one ${name} copy in the tree`).toBeGreaterThan(0);
  const breaching = resolved.filter((v) => !resolvedVersionMeetsFloor(v, fixed));
  expect(
    breaching,
    `lockfile resolves ${name} ${breaching.join(", ")} below ${fixed.join(".")}. ${why}`,
  ).toEqual([]);
}

/**
 * Asserts an override governs `name`, that its target floor meets `fixed`, and that any
 * `<` bound in its selector moved with that floor (#1208).
 *
 * @param {string} name
 * @param {Triple} fixed
 */
function expectOverrideAtLeast(name, fixed) {
  const entries = [...(effective?.entries() ?? [])].filter(
    ([key]) => key === name || key.startsWith(`${name}@`),
  );
  expect(entries, `no override governs ${name}`).not.toHaveLength(0);
  for (const [key, target] of entries) {
    expect(
      rangeMeetsFloor(target, fixed),
      `override "${key}" targets "${target}", below the fixed ${fixed.join(".")}`,
    ).toBe(true);
    const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
    if (ceiling !== undefined) {
      expect(
        resolvedVersionMeetsFloor(ceiling, fixed),
        `override key "${key}" bounds at ${ceiling}, below the fixed ${fixed.join(".")}: ` +
          "a consumer whose declared range sits between the two is never governed (#1208)",
      ).toBe(true);
    }
  }
}

describe("the #903 advisory set is closed in the resolved tree", () => {
  it("has an effective override set at all", () => {
    expect(effective, "pnpm-lock.yaml has no top-level `overrides:` block").not.toBeNull();
  });

  describe("@modelcontextprotocol/sdk — GHSA-6qxp-vccf-f47h (CVSS 7.5), fixed 1.31.0", () => {
    const FIXED = /** @type {Triple} */ ([1, 31, 0]);

    it("server declares 1.31.0 or above", () => {
      const range = declaredRange("server/package.json", "@modelcontextprotocol/sdk");
      expect(range, "server no longer declares @modelcontextprotocol/sdk").toBeDefined();
      expect(rangeMeetsFloor(range, FIXED), `server declares "${range}"`).toBe(true);
    });

    it("resolves no copy below 1.31.0", () => {
      expectNoCopyBelow(
        "@modelcontextprotocol/sdk",
        FIXED,
        "The OAuth client could send credentials to an attacker-chosen authorization server.",
      );
    });
  });

  describe("simple-git — GHSA-x6jw-m9v5-85vh (9.2) / -858h- / -g4wm- (8.1), fixed 4.0.1", () => {
    const FIXED = /** @type {Triple} */ ([4, 0, 1]);

    it("server declares 4.0.1 or above", () => {
      const range = declaredRange("server/package.json", "simple-git");
      expect(range, "server no longer declares simple-git").toBeDefined();
      expect(rangeMeetsFloor(range, FIXED), `server declares "${range}"`).toBe(true);
    });

    it("resolves no copy below 4.0.1", () => {
      expectNoCopyBelow(
        "simple-git",
        FIXED,
        "3.x has no fix for any of the three: the unsafe-operation guards are bypassable " +
          "by option abbreviation, config includes and trailer commands.",
      );
    });
  });

  describe("@simple-git/argv-parser — GHSA-v5rq-49vh-5v5c (CVSS 9.2), fixed 2.0.1", () => {
    it("resolves no copy below 2.0.1", () => {
      expectNoCopyBelow(
        "@simple-git/argv-parser",
        [2, 0, 1],
        "simple-git pins it EXACTLY, so it moves only with simple-git (4.0.2 pins 2.0.1).",
      );
    });
  });

  describe("proxy-addr — GHSA-jqcg-44mw-7w3h (CVSS 9.1), fixed 2.0.8", () => {
    const FIXED = /** @type {Triple} */ ([2, 0, 8]);
    it("is overridden to 2.0.8 or above", () => expectOverrideAtLeast("proxy-addr", FIXED));
    it("resolves no copy below 2.0.8", () => {
      expectNoCopyBelow(
        "proxy-addr",
        FIXED,
        "It decides `req.ip` behind `trust proxy` for express in server and embeddings-svc.",
      );
    });
  });

  describe("seroval — GHSA-p6vx-979v-rg4c (9.8, fixed 1.6.2) / GHSA-jp82-f5mq-hwhp (7.5, fixed 1.6.3)", () => {
    const FIXED = /** @type {Triple} */ ([1, 6, 3]);
    it("is overridden to 1.6.3 or above", () => expectOverrideAtLeast("seroval", FIXED));
    it("resolves no copy below 1.6.3", () => {
      expectNoCopyBelow(
        "seroval",
        FIXED,
        "solid-js@1.9.15 declares `seroval: ~1.5.4`; only solid-js 1.9.16 moves to ~1.6.8.",
      );
    });
  });

  describe("sharp — GHSA-wq5f-xc86-pv6w (CVSS 8.9), fixed 0.35.5", () => {
    const FIXED = /** @type {Triple} */ ([0, 35, 5]);
    it("is overridden to 0.35.5 or above", () => expectOverrideAtLeast("sharp", FIXED));
    it("resolves no copy below 0.35.5", () => {
      expectNoCopyBelow("sharp", FIXED, "Its bundled librsvg carries CVE-2026-96889.");
    });
  });

  describe("source-map-js — GHSA-68fv-2mgg-jv7q (CVSS 8.7), fixed 1.2.2", () => {
    const FIXED = /** @type {Triple} */ ([1, 2, 2]);
    it("is overridden to 1.2.2 or above", () => expectOverrideAtLeast("source-map-js", FIXED));
    it("resolves no copy below 1.2.2", () => {
      expectNoCopyBelow("source-map-js", FIXED, "Event-loop DoS via indexed section offsets.");
    });
  });
});
