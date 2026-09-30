import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolvedLockfileVersions, resolvedVersionMeetsFloor } from "./pnpm-overrides-core.mjs";

/**
 * Regression guard for GHSA-v53p-9fqp-m79j (#426): quadratic backtracking in
 * nodemailer's addressparser free-text fallback, a remote DoS, CVSS 7.5, affected
 * `<= 10.0.5`, published 2026-09-29 against an UNCHANGED lockfile.
 *
 * No 9.x release fixes it, so this is the 10.x major bump that
 * `dependency-audit-1363-advisories.test.mjs` required to be its own PR. 10.0.0's only
 * listed breaking change is "Node.js 20 or newer is required"; the repo requires
 * Node >= 22.19.0. 10.0.10 is the newest release clear of `minimumReleaseAge` at bump
 * time, and api.osv.dev returned zero vulns for it on 2026-09-29.
 *
 * nodemailer is a DIRECT server dependency with one resolved copy, so the manifest is
 * the pin (see the #1363 file's `declaredRange` note); the lockfile arm catches a new
 * transitive consumer dragging an affected copy back in.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");

const FIXED = /** @type {[number, number, number]} */ ([10, 0, 6]);

describe("nodemailer — GHSA-v53p-9fqp-m79j (#426)", () => {
  it("server/package.json declares a nodemailer floor of 10.0.6 or above", () => {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "server/package.json"), "utf8"));
    const range = manifest.dependencies?.nodemailer;
    expect(range, "server/package.json declares no nodemailer dependency").toBeDefined();
    const floor = /(\d+)\.(\d+)\.(\d+)/.exec(range);
    expect(floor, `server nodemailer range "${range}" carries no version`).not.toBeNull();
    expect(
      resolvedVersionMeetsFloor(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
      `server/package.json declares nodemailer "${range}", inside GHSA-v53p-9fqp-m79j (<= 10.0.5)`,
    ).toBe(true);
  });

  it("resolves NO nodemailer copy at or below 10.0.5", () => {
    const resolved = resolvedLockfileVersions(lockfile, "nodemailer");
    expect(resolved.length, "expected at least one nodemailer copy in the tree").toBeGreaterThan(0);
    const breaching = resolved.filter((v) => !resolvedVersionMeetsFloor(v, FIXED));
    expect(breaching, `lockfile resolves nodemailer ${breaching.join(", ")} <= 10.0.5`).toEqual([]);
  });
});
