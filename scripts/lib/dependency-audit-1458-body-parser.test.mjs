import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolvedLockfileVersions, resolvedVersionMeetsFloor } from "./pnpm-overrides-core.mjs";

/**
 * Regression guard for body-parser GHSA-27r3-jxmh-p828 (#1458): HIGH, "Denial of Service
 * via trailing bytes after a compressed request body", affected `>=2.0.0 <2.4.0` and
 * `<1.20.9`. It turned `Dependency audit` red on every PR on 2026-10-23.
 *
 * The fix, 2.4.0, was published 2026-10-22T11:39Z, and the 7-day pnpm
 * `minimumReleaseAge` holds it until 2026-10-29T11:39Z. We do not bypass that gate.
 * Instead, until the upgrade:
 *
 *   - MITIGATED: every server body parser is built with `inflate: false`, so the
 *     compressed-body path never runs (server/src/middleware/body-parsers.ts; behaviour
 *     in server/tests/body-parser-inflate-1458.test.ts, inventory in
 *     server/src/middleware/body-parsers.inflate.test.ts).
 *   - WAIVED in sast.yml, scoped to the exact vulnerable copies the lockfile resolves and
 *     dated to expire the day after the release age clears.
 *
 * This file ties the two together: the waiver may exist only while a vulnerable copy is
 * resolved, may cover only those copies, may not be re-dated past 2026-10-30, and may not
 * outlive the mitigation that justifies it.
 */

const ADVISORY = "GHSA-27r3-jxmh-p828";
const FIXED_2X = /** @type {const} */ ([2, 4, 0]);
const FIXED_1X = /** @type {const} */ ([1, 20, 9]);
/** The day after 2.4.0 clears minimumReleaseAge. Moving this is a decision, not a refresh. */
const LATEST_EXPIRY = "2026-10-30";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
const workflowText = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "sast.yml"), "utf8");
const parsersSource = readFileSync(
  resolve(REPO_ROOT, "server", "src", "middleware", "body-parsers.ts"),
  "utf8",
);

const PYTHON3 = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

/** Is an exact resolved body-parser version inside the advisory's affected ranges? */
function isVulnerable(version) {
  if (resolvedVersionMeetsFloor(version, [2, 0, 0])) {
    return !resolvedVersionMeetsFloor(version, FIXED_2X);
  }
  return !resolvedVersionMeetsFloor(version, FIXED_1X);
}

/**
 * The live waiver for the advisory, read the way the gate reads it — the dict is executed
 * in python3 when available; otherwise sliced from the located block. "Not found" fails
 * instead of reading as "no waiver".
 *
 * @returns {{ expires: string, packages?: string[], reason: string } | undefined}
 */
function liveWaiver() {
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

  if (PYTHON3) {
    const run = spawnSync(
      "python3",
      ["-c", `${block}\nimport json\nprint(json.dumps(WAIVERS))\n`],
      { encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout)[ADVISORY];
  }
  const at = block.indexOf(`"${ADVISORY}":`);
  if (at === -1) return undefined;
  const entry = block.slice(at);
  return {
    expires: /"expires":\s*"([\d-]+)"/.exec(entry)?.[1] ?? "",
    packages: [...(/"packages":\s*\[([^\]]*)\]/.exec(entry)?.[1].matchAll(/"([^"]+)"/g) ?? [])].map(
      (m) => m[1],
    ),
    reason: /"reason"/.test(entry) ? "present" : "",
  };
}

const resolved = resolvedLockfileVersions(lockfile, "body-parser");
const vulnerableCopies = resolved.filter(isVulnerable).map((v) => `body-parser@${v}`);

describe("body-parser GHSA-27r3-jxmh-p828 is fixed or mitigated-and-scoped-waived (#1458)", () => {
  it("classifies the advisory's ranges correctly (the predicate the rest relies on)", () => {
    expect(isVulnerable("2.2.2")).toBe(true);
    expect(isVulnerable("2.3.9")).toBe(true);
    expect(isVulnerable("2.4.0")).toBe(false);
    expect(isVulnerable("1.20.8")).toBe(true);
    expect(isVulnerable("1.20.9")).toBe(false);
  });

  it("finds body-parser in the resolved tree (the checks below are not vacuous)", () => {
    expect(resolved.length, "expected at least one body-parser copy").toBeGreaterThan(0);
  });

  it("waives exactly the vulnerable copies the lockfile resolves, or nothing once none remain", () => {
    const w = liveWaiver();
    if (vulnerableCopies.length === 0) {
      // Upgraded past 2.4.0: the waiver is dead weight, and keeping it is how a mute
      // outlives its reason.
      expect(w, `no vulnerable body-parser is resolved; delete the ${ADVISORY} waiver`).toBe(
        undefined,
      );
      return;
    }
    expect(
      w,
      `${vulnerableCopies.join(", ")} resolved but sast.yml has no ${ADVISORY} waiver`,
    ).toBeDefined();
    expect(
      [...(w?.packages ?? [])].sort(),
      "an unscoped waiver would also mute a regression on a fixed copy",
    ).toEqual([...vulnerableCopies].sort());
    expect(w?.reason ?? "", "the waiver must say why").not.toBe("");
  });

  it(`never lets the waiver run past ${LATEST_EXPIRY}: upgrade and delete, don't re-date`, () => {
    const w = liveWaiver();
    if (w === undefined) return;
    expect(w.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(w.expires <= LATEST_EXPIRY, `waiver re-dated to ${w.expires}`).toBe(true);
  });

  it("keeps the inflate: false mitigation the waiver rests on, for both parser kinds", () => {
    if (liveWaiver() === undefined) return;
    expect(parsersSource).toMatch(/express\.json\(\{\s*\.\.\.options,\s*inflate:\s*false\s*\}\)/);
    expect(parsersSource).toMatch(
      /express\.urlencoded\(\{\s*\.\.\.options,\s*inflate:\s*false\s*\}\)/,
    );
  });
});
