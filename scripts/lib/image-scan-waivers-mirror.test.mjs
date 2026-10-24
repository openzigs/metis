import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseRetired, parseWaivers } from "./image-scan-gate.mjs";

/**
 * #1489 — an image-scan waiver for an npm finding mirrors the OSV Dependency-audit waiver
 * of the same advisory in `.github/workflows/sast.yml`.
 *
 * Trivy reports an npm advisory under its CVE alias; the OSV gate waives the same advisory
 * under its GHSA id. On 2026-10-24 four GHSAs already waived in sast.yml gained CVE
 * aliases in the Trivy DB and turned the `api` job red on `main`. The two gates read the
 * same lockfile copies, so a waiver in one with a different expiry, or a different package
 * scope, than its twin in the other is two sources of truth: the image waiver could
 * silently outlive the reachability argument the lockfile waiver was retired with.
 *
 * So every image waiver carrying `mirrors` must name a live sast.yml WAIVERS entry with the
 * SAME `expires` and the SAME `packages`, and every reachability guard it names must exist.
 * The WAIVERS dict is executed with python3 (as sast-waiver-expiry.test.mjs does) so a
 * comment or continuation cannot desynchronise this reading from the gate's own.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const waiverDoc = JSON.parse(
  fs.readFileSync(path.join(repoRoot, ".github/image-scan-waivers.json"), "utf8"),
);
const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/sast.yml"), "utf8");

/** @returns {Record<string, {expires: string, packages?: string[]}>} */
function sastWaivers() {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l.trim() === "python3 - <<'PY'");
  const end = lines.findIndex((l, i) => i > start && l.trim() === "PY");
  expect(start, "sast.yml has no `python3 - <<'PY'` heredoc").toBeGreaterThan(-1);
  expect(end, "the PY heredoc in sast.yml is unterminated").toBeGreaterThan(start);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(
    ...body.filter((l) => l.trim()).map((l) => /** @type {string} */ (l.match(/^ */)?.[0]).length),
  );
  const script = body.map((l) => l.slice(indent)).join("\n");
  const block = /^WAIVERS = \{(?:\}$|[\s\S]*?^\}$)/m.exec(script)?.[0];
  expect(block, "the WAIVERS dict could not be located in sast.yml").toBeTruthy();
  const run = spawnSync("python3", ["-c", `${block}\nimport json\nprint(json.dumps(WAIVERS))\n`], {
    encoding: "utf8",
  });
  expect(run.status, `executing sast.yml's WAIVERS failed:\n${run.stderr}`).toBe(0);
  return JSON.parse(run.stdout);
}

const python3 = spawnSync("python3", ["-c", "print(1)"]).status === 0;
const waivers = parseWaivers(waiverDoc);
const mirrored = waivers.filter((w) => "mirrors" in w);

describe("image-scan waivers mirror their sast.yml twins (#1489)", () => {
  it("each advisory of #1489 is a mirror in `waivers`, or has been retired to `expired`", () => {
    const retired = new Set(parseRetired(waiverDoc).map((w) => w.id));
    const byId = Object.fromEntries(mirrored.map((w) => [w.id, /** @type {any} */ (w).mirrors]));
    for (const [cve, ghsa] of Object.entries({
      "CVE-2026-109461": "GHSA-xcx6-jx8p-x3h5",
      "CVE-2026-111181": "GHSA-27r3-jxmh-p828",
      "CVE-2026-113872": "GHSA-q7qp-rjg7-q26m",
      "CVE-2023-54404": "GHSA-mrhx-c7xc-m3w5",
    })) {
      if (retired.has(cve)) continue;
      expect(byId[cve], `${cve} must be waived as a mirror of ${ghsa}, or moved to expired`).toBe(
        ghsa,
      );
    }
  });

  it("CI has python3, so the comparison below cannot skip there", () => {
    if (process.env.CI) {
      expect(python3, "python3 is required to execute sast.yml's WAIVERS").toBe(true);
    }
  });

  it.runIf(python3)("each mirror matches its sast.yml waiver's expiry and package scope", () => {
    const sast = sastWaivers();
    for (const w of mirrored) {
      const ghsa = /** @type {any} */ (w).mirrors;
      const twin = sast[ghsa];
      expect(
        twin,
        `${w.id} mirrors ${ghsa}, which sast.yml no longer waives: retire this entry too`,
      ).toBeDefined();
      expect(w.expires, `${w.id} expiry differs from ${ghsa} in sast.yml`).toBe(twin.expires);
      expect([...(w.packages ?? [])].sort(), `${w.id} packages differ from ${ghsa}`).toEqual(
        [...(twin.packages ?? [])].sort(),
      );
    }
  });

  it("every mirror names reachability guards that exist", () => {
    for (const w of mirrored) {
      const guards = /** @type {any} */ (w).guards;
      expect(Array.isArray(guards) && guards.length > 0, `${w.id} names no guard test`).toBe(true);
      for (const g of guards) {
        expect(fs.existsSync(path.join(repoRoot, g)), `${w.id}: guard ${g} is missing`).toBe(true);
      }
    }
  });
});
