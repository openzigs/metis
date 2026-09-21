import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * No waiver in `.github/workflows/sast.yml` may be past its own expiry date (#1324).
 *
 * ## The hole this fills
 *
 * `sast-waiver-gate.test.mjs` (#1215) tests the waiver MECHANISM — that a live waiver
 * suppresses and an expired one stops suppressing — and it does so against a fixture
 * dict, deliberately, so the suite is not coupled to a calendar date. That was the right
 * call for the mechanism, and it leaves this gap: **nothing local ever looks at the real
 * dict.** A waiver could therefore sit expired in the tree with a green `pnpm test`.
 *
 * That is not hypothetical. It is #1324, measured: `GHSA-2v37-7h3g-55p8` expired on
 * 2026-08-11, `Dependency audit` went red on the scheduled `main` run of 2026-08-16, and
 * it stayed red for two weeks while every PR opened in that window inherited a failure it
 * did not cause. The unit suite was green throughout.
 *
 * ## Why this one IS allowed to be calendar-coupled, when #1215's arms are not
 *
 * The objection to a wall-clock assertion is that it turns an innocent PR red for a
 * reason that PR did not cause. Here that has already happened *in CI* by construction:
 * the moment a waiver expires, `Dependency audit` fails on `main` and on every open PR.
 * So this arm adds no new red — it moves an existing one **earlier and closer to the
 * cause**, from a scheduled workflow whose failure everyone learned to ignore into
 * `pnpm test`, with a message that names the file, the advisory and the two lawful
 * remedies. An alarm nobody can attribute is the failure mode of #1324; an alarm that
 * fires at the author is the fix.
 *
 * ## The comparison is the GATE'S OWN, not a re-derivation
 *
 * `waiver_for()` in sast.yml suppresses only while `today < expires`. So a waiver is
 * already inert ON its expiry date, not the day after, and this arm uses `>=` for exactly
 * that reason. Re-deriving the boundary as "expires < today" would leave a one-day window
 * in which the gate is red and this test is green — two sources of truth with different
 * filters, which is shape 2 of #1215 and the way four verify gates in one week failed
 * open.
 *
 * ## Enumeration executes the dict; it does not grep it
 *
 * Per the `sast-waiver-verification-recipe` memo, a truncated `grep -A` window miscounted
 * `WAIVERS` during #1010. The authoritative path here `exec`s the real dict in python3.
 * The python3-free fallback is a regex over the *located block*, and either way the block
 * having been located is asserted first — so "the dict moved or was renamed" fails loudly
 * instead of reporting zero waivers and passing. A default that means "nothing to check"
 * is how #1168/#1178/#1180/#1192 all shipped gates that could not fail.
 */

const repoRoot = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");
const WORKFLOW = path.join(repoRoot, ".github", "workflows", "sast.yml");
const workflowText = fs.readFileSync(WORKFLOW, "utf8");

const PYTHON3 = (() => {
  const probe = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" });
  return probe.status === 0;
})();

/**
 * Lift the threshold script out of the workflow's `python3 - <<'PY'` heredoc.
 *
 * Duplicated from `sast-waiver-gate.test.mjs` on purpose rather than shared: hoisting it
 * into a module both files import would make a single edit able to disarm both guards at
 * once, and these two exist to check different claims about the same file.
 *
 * @returns {string}
 */
function extractThresholdScript() {
  const lines = workflowText.split("\n");
  const start = lines.findIndex((line) => line.trim() === "python3 - <<'PY'");
  const end = lines.findIndex((line, i) => i > start && line.trim() === "PY");
  expect(start, "sast.yml no longer contains a `python3 - <<'PY'` heredoc").toBeGreaterThan(-1);
  expect(end, "the PY heredoc in sast.yml is unterminated").toBeGreaterThan(start);

  const body = lines.slice(start + 1, end);
  const indent = Math.min(
    ...body.filter((line) => line.trim().length > 0).map((line) => line.match(/^ */)[0].length),
  );
  return `${body.map((line) => line.slice(indent)).join("\n")}\n`;
}

/**
 * The literal source of the `WAIVERS` assignment, from `WAIVERS = {` to its closing brace.
 *
 * Handles both the multi-line form and the single-line `WAIVERS = {}` steady state. The
 * caller asserts this is non-null, which is the identity check: a renamed or relocated
 * dict must not read as "no waivers".
 *
 * @param {string} script
 * @returns {string | null}
 */
function waiversBlock(script) {
  const match = /^WAIVERS = \{(?:\}$|[\s\S]*?^\}$)/m.exec(script);
  return match ? match[0] : null;
}

/**
 * Every `(advisoryId, expires)` pair the real dict holds.
 *
 * @param {string} script
 * @returns {Array<[string, string]>}
 */
function readWaiverExpiries(script) {
  const block = waiversBlock(script);
  expect(
    block,
    "the `WAIVERS` dict could not be located in sast.yml. It was renamed, moved or " +
      "reshaped — which must fail this guard rather than report zero waivers and pass.",
  ).not.toBeNull();

  if (PYTHON3) {
    // Authoritative: execute the dict, so a comment, a continuation or a computed value
    // cannot desynchronise the reading from what the gate itself sees.
    const program = `${block}\nimport json\nprint(json.dumps({k: v["expires"] for k, v in WAIVERS.items()}))\n`;
    const run = spawnSync("python3", ["-c", program], { encoding: "utf8" });
    expect(
      run.status,
      `executing the WAIVERS dict from sast.yml failed:\n${run.stderr}\n` +
        "Every entry must be a mapping carrying an `expires` key.",
    ).toBe(0);
    return Object.entries(JSON.parse(run.stdout));
  }

  // Fallback for a container with no python3. Still anchored to the located block, so it
  // cannot find zero because it searched the wrong place.
  return [...block.matchAll(/"(GHSA-[\w-]+)":[\s\S]*?"expires":\s*"(\d{4}-\d{2}-\d{2})"/g)].map(
    (m) => [m[1], m[2]],
  );
}

describe("sast.yml advisory waivers are all still in date (#1324)", () => {
  const script = extractThresholdScript();

  it("still gates on `today < expires`, the semantics this suite asserts against", () => {
    // If the gate ever changes when a waiver lapses, the arm below is measuring the wrong
    // boundary and must be updated with it. Asserting the source here is what couples the
    // two, instead of leaving a second source of truth to drift (#1215 shape 2).
    expect(
      script,
      "sast.yml's `waiver_for()` no longer compares `today < expires`. The expiry " +
        "boundary asserted below is derived from that comparison — reconcile them.",
    ).toContain('if today < datetime.date.fromisoformat(w["expires"]):');
  });

  it("has no waiver whose expiry date has already passed", () => {
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    // `waiver_for()` suppresses only while `today < expires`, so a waiver is ALREADY inert
    // on its expiry date. `>=`, not `>`.
    const stale = readWaiverExpiries(script).filter(([, expires]) => todayIso >= expires);

    expect(
      stale.map(([id, expires]) => `${id} (expired ${expires})`),
      "These waivers in .github/workflows/sast.yml no longer suppress anything, so " +
        "`Dependency audit` is red on main and on every open PR right now. Two lawful " +
        "remedies: upgrade the dependency past the advisory and DELETE the entry, or " +
        "record a fresh dated waiver that states why the fixed version still cannot be " +
        "installed. Silently pushing the date out is the failure #1324 exists to correct.",
    ).toEqual([]);
  });

  it("gives every waiver an expiry and a reason, so none can be open-ended", () => {
    const block = waiversBlock(script);
    const ids = readWaiverExpiries(script).map(([id]) => id);
    for (const id of ids) {
      // Scoped to THIS entry, from its own key to the next advisory key. An unbounded
      // search would let one entry's `reason` vouch for a later entry that has none.
      // Plain string slicing, not an interpolated `new RegExp` — that is a
      // `detect-non-literal-regexp` finding, and the Semgrep job blocks on it.
      const start = block.indexOf(`"${id}":`);
      expect(start, `waiver ${id} vanished from the WAIVERS block between reads`).toBeGreaterThan(
        -1,
      );
      const next = block.indexOf('"GHSA-', start + id.length + 3);
      const entry = next === -1 ? block.slice(start) : block.slice(start, next);
      expect(
        entry.includes('"reason"'),
        `waiver ${id} carries no \`reason\`. A waiver must say why the fixed version ` +
          "cannot be installed yet, or it is just a mute.",
      ).toBe(true);
    }
    // Vacuously true today (the dict is empty), and deliberately so: this arm is the
    // ratchet that meets the next waiver, not an assertion about the current tree.
    expect(new Set(ids).size, "duplicate advisory IDs in WAIVERS").toBe(ids.length);
  });
});
