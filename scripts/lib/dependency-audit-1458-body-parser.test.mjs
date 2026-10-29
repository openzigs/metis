import { spawnSync } from "node:child_process";
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
 * Upgrade guard for body-parser GHSA-27r3-jxmh-p828: HIGH, CVSS 7.5, "Denial of Service via
 * trailing bytes after a compressed request body", affected `>=2.0.0 <2.4.0` and `<1.20.9`.
 *
 * #1458 mitigated it (`inflate: false` on every parser) and waived body-parser@2.2.2 while
 * the fixed 2.4.0 served out the 7-day pnpm `minimumReleaseAge`. #1460 took 2.4.0 once it
 * cleared the gate, through a `pnpm-workspace.yaml` override whose selector bound equals
 * the fix floor (#1208), and deleted the waiver from sast.yml and its image-scan mirror.
 *
 * Same shape as the #1420 and #1453 guards: the audit is a live OSV query, so it alarms well
 * and regresses poorly. This file objects when the override is deleted or weakened, when any
 * resolved copy falls below the floor, or when a waiver for the advisory comes back. Every
 * arm reads the resolved lockfile or the gate's own waiver dict, never an override string
 * alone. `inflate: false` stays as the default (no METIS client sends a compressed body);
 * server/src/middleware/body-parsers.inflate.test.ts keeps guarding it.
 */

const ADVISORY = "GHSA-27r3-jxmh-p828";
const FIXED = /** @type {const} */ ([2, 4, 0]);
const FLOOR = FIXED.join(".");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
const effective = parseTopLevelOverrides(lockfile);
const workflowText = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "sast.yml"), "utf8");
const imageWaivers = JSON.parse(
  readFileSync(resolve(REPO_ROOT, ".github", "image-scan-waivers.json"), "utf8"),
);

const PYTHON3 = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

/**
 * The gate's WAIVERS dict, read the way the gate reads it: executed in python3 when
 * available, otherwise searched as text. "Not found" fails instead of reading as "no waiver".
 *
 * @returns {boolean} whether sast.yml waives the advisory
 */
function sastWaives(advisory) {
  const lines = workflowText.split("\n");
  const start = lines.findIndex((line) => line.trim() === "python3 - <<'PY'");
  const end = lines.findIndex((line, i) => i > start && line.trim() === "PY");
  expect(start, "sast.yml no longer contains the threshold heredoc").toBeGreaterThan(-1);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(
    ...body.filter((l) => l.trim().length > 0).map((l) => l.match(/^ */)[0].length),
  );
  const script = body.map((l) => l.slice(indent)).join("\n");
  const block = /^WAIVERS = \{(?:\}$|[\s\S]*?^\}$)/m.exec(script)?.[0];
  expect(block, "the WAIVERS dict could not be located in sast.yml").toBeDefined();
  if (!PYTHON3) return block.includes(`"${advisory}"`);
  const run = spawnSync("python3", ["-c", `${block}\nimport json\nprint(json.dumps(WAIVERS))\n`], {
    encoding: "utf8",
  });
  expect(run.status, run.stderr).toBe(0);
  return advisory in JSON.parse(run.stdout);
}

const resolved = resolvedLockfileVersions(lockfile, "body-parser");

describe("body-parser GHSA-27r3-jxmh-p828 is fixed by upgrade, not waived (#1458, #1460)", () => {
  it("finds body-parser in the resolved tree (the checks below are not vacuous)", () => {
    // An empty lookup would otherwise read as "no vulnerable copy present".
    expect(resolved.length, "expected at least one body-parser copy").toBeGreaterThan(0);
  });

  it(`resolves every body-parser copy at or above ${FLOOR}`, () => {
    const breaching = resolved.filter((v) => !resolvedVersionMeetsFloor(v, FIXED));
    expect(
      breaching,
      `lockfile resolves body-parser ${breaching.join(", ")} below ${FLOOR} (${ADVISORY})`,
    ).toEqual([]);
  });

  it(`the body-parser override targets ^${FLOOR} and bounds at it (#1208)`, () => {
    expect(effective, "pnpm-lock.yaml has no top-level `overrides:` block").not.toBeNull();
    const entries = [...(effective?.entries() ?? [])].filter(([key]) =>
      key.startsWith("body-parser@"),
    );
    // express 5.3.0 still asks only for `^2.3.0`, so the override is what holds the floor.
    expect(entries, "no override governs body-parser").not.toHaveLength(0);
    for (const [key, target] of entries) {
      const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
      expect(ceiling, `override key "${key}" carries no upper bound`).toBeDefined();
      expect(
        resolvedVersionMeetsFloor(ceiling ?? "0.0.0", FIXED),
        `override key "${key}" bounds below the fixed ${FLOOR}: a consumer between the two ` +
          "is never governed (#1208)",
      ).toBe(true);
      expect(target, `override "${key}" targets "${target}"`).toBe(`^${ceiling}`);
    }
  });

  it("carries no sast.yml waiver for the advisory: it is fixed, not muted", () => {
    expect(sastWaives(ADVISORY), `delete the ${ADVISORY} waiver from sast.yml`).toBe(false);
  });

  it("retired its image-scan mirror (CVE-2026-111181) to `expired`, not deleted", () => {
    const live = imageWaivers.waivers.filter((w) => w.id === "CVE-2026-111181");
    expect(live, "CVE-2026-111181 is still an active image-scan waiver").toEqual([]);
    expect(imageWaivers.expired.map((w) => w.id)).toContain("CVE-2026-111181");
  });
});
