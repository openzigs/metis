import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The OSV severity-threshold gate embedded in `.github/workflows/sast.yml` (#1215).
 *
 * ## Why this test exists at all
 *
 * That gate decides, on every PR, whether a dependency advisory blocks the merge —
 * and it had **no test of any kind**. It is a Python heredoc inside a YAML `run:`
 * block, which is precisely the sort of place a rule goes unexercised: it cannot be
 * imported, it never runs locally, and CI only ever executes it against the one
 * advisory set the current lockfile happens to produce. Reading it found nothing
 * across two reviews.
 *
 * Executing it found this: OSV emits `max_severity: ""` for any group whose
 * advisories carry no CVSS vector, `float("")` raises, and the old code set
 * `score = None` and then tested `score is not None and score >= THRESHOLD`. So an
 * advisory with no CVSS was skipped from the aggregate entirely — printed
 * `[UNSCORED]`, and the gate exited **0**.
 *
 * That is not a corner case. It is the exact shape of the npm supply-chain
 * compromises this gate exists to catch: `GHSA-g2q5-5433-rhrf` (`rc`, embedded
 * malware) and `GHSA-73qr-pfmq-6rp8` (`coa`) are both **CRITICAL with no `severity`
 * array at all** — verified against api.osv.dev, and the shape the CRITICAL arm below
 * replays verbatim.
 *
 * ## How it is tested
 *
 * The Python is extracted from the **real** workflow file and run for real. A stand-in
 * copy could not regress, and extracting rather than duplicating is what makes an edit
 * to `sast.yml` land here: rewrite the threshold logic and these arms re-run against
 * the rewrite.
 */

const repoRoot = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");
const WORKFLOW = path.join(repoRoot, ".github", "workflows", "sast.yml");

/**
 * Is there a `python3` on PATH? Measured, not inferred: the gate's own job installs
 * one, but a container running the unit suite need not have it. The arms skip rather
 * than fail there — a missing interpreter is not a defect in the gate.
 */
const PYTHON3 = (() => {
  const probe = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" });
  return probe.status === 0;
})();

/** The advisory ID the waiver arms use. Deliberately not one this repo ever waives. */
const FIXTURE_WAIVER_ID = "GHSA-fixt-ure0-0000";

/**
 * Lift the threshold script out of the workflow's `python3 - <<'PY'` heredoc.
 *
 * The body is indented for YAML; the shell strips that before the interpreter sees
 * it, so the common indent is removed here for the same reason.
 *
 * @returns {string}
 */
function extractThresholdScript() {
  const lines = fs.readFileSync(WORKFLOW, "utf8").split("\n");
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
 * Substitute a fixture `WAIVERS` dict and a fixed `today` into the extracted script.
 *
 * ## Why the arms do not use the real dict
 *
 * The first version of this file asserted against the live `GHSA-mh99-v99m-4gvg` entry.
 * That waiver expires 2026-08-13 and its own comment instructs deleting it on/after
 * 2026-08-05 (#1211) — so `pnpm test` would have gone red on a wall-clock date, and
 * #1211 would have inherited a broken suite it did nothing to cause. Asserting a gate's
 * behaviour against live production config is issue #1215's own shape 2: two sources of
 * truth with different lifetimes.
 *
 * So the waiver *mechanism* is tested against a fixture, deterministically and forever,
 * while the real dict is left entirely alone. This is strictly better than skipping when
 * no waiver is live: skipping would leave the suppression path untested in the steady
 * state where every waiver has been deleted, which is the "silently did not run" failure
 * this whole change is about. It also lets the **expiry** path be tested, which nothing
 * covered before.
 *
 * Both substitutions are asserted to have applied. If the workflow renames `WAIVERS` or
 * stops calling `datetime.date.today()`, these arms fail loudly rather than quietly
 * testing production config again.
 *
 * @param {string} script
 * @param {{ waivers?: string, today?: string }} options
 * @returns {string}
 */
function withFixtureWaivers(script, { waivers, today }) {
  let out = script;
  if (waivers !== undefined) {
    const before = out;
    // The `\{\}` alternative is load-bearing and comes first: once #1211 deletes the
    // last entry the dict collapses to a single-line `WAIVERS = {}`, which the
    // multi-line form does not match. Without it the substitution silently fails to
    // apply, the assertion below fires, and #1211 inherits a red suite — the exact
    // outcome this decoupling exists to prevent. Verified by executing both futures.
    out = out.replace(/^WAIVERS = \{(?:\}$|[\s\S]*?^\}$)/m, waivers);
    expect(out, "the WAIVERS dict in sast.yml could not be located for substitution").not.toBe(
      before,
    );
  }
  if (today !== undefined) {
    const before = out;
    out = out.replace(
      /^today = datetime\.date\.today\(\)$/m,
      `today = datetime.date.fromisoformat(${JSON.stringify(today)})`,
    );
    expect(out, "the `today` assignment in sast.yml could not be located").not.toBe(before);
  }
  return out;
}

/**
 * Run the real gate over one `osv-results.json`.
 *
 * @param {unknown} results the JSON osv-scanner would have written
 * @param {{ waivers?: string, today?: string }} [fixture] optional WAIVERS/today overrides
 * @returns {{ status: number, output: string }}
 */
function runGate(results, fixture = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sast-waiver-"));
  try {
    fs.writeFileSync(path.join(dir, "osv-results.json"), JSON.stringify(results), "utf8");
    fs.writeFileSync(
      path.join(dir, "threshold.py"),
      withFixtureWaivers(extractThresholdScript(), fixture),
      "utf8",
    );
    const result = spawnSync("python3", ["threshold.py"], { cwd: dir, encoding: "utf8" });
    return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A fixture dict holding exactly one waiver, expiring on a fixed date. */
const FIXTURE_WAIVERS = [
  "WAIVERS = {",
  `    ${JSON.stringify(FIXTURE_WAIVER_ID)}: {`,
  '        "expires": "2030-01-01",',
  '        "reason": "fixture waiver for the gate\'s own tests",',
  "    },",
  "}",
].join("\n");

/**
 * One osv-scanner group, in the producer's real shape.
 *
 * `maxSeverity` is a STRING because that is what OSV writes, and `""` — not a missing
 * key, not `null` — is what it writes when no advisory in the group has a CVSS vector.
 * #1213 shipped a fix containing its own defect because its arm tested a shape the
 * producer never emits, so this helper exists to keep every arm on the real one.
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string} [input.version]
 * @param {string} input.id
 * @param {string} input.maxSeverity
 * @param {string | null} [input.label] `database_specific.severity`, or null for none
 */
function advisory({ name, version = "1.0.0", id, maxSeverity, label = null }) {
  return {
    results: [
      {
        packages: [
          {
            package: { name, version, ecosystem: "npm" },
            groups: [{ ids: [id], aliases: [id], max_severity: maxSeverity }],
            vulnerabilities: [{ id, database_specific: label === null ? {} : { severity: label } }],
          },
        ],
      },
    ],
  };
}

describe.skipIf(!PYTHON3)("sast.yml OSV threshold gate (Issue #1215)", () => {
  it("PASSES a scored advisory below the High threshold", () => {
    const { status, output } = runGate(
      advisory({ name: "body-parser", id: "GHSA-v422-hmwv-36x6", maxSeverity: "3.7" }),
    );
    expect(status).toBe(0);
    expect(output).toContain("[LOW]");
    expect(output).toContain("PASS:");
  });

  it("FAILS a scored advisory at or above the High threshold", () => {
    const { status, output } = runGate(
      advisory({ name: "some-pkg", id: "GHSA-scored-high", maxSeverity: "7.5" }),
    );
    expect(status).toBe(1);
    expect(output).toContain("[HIGH]");
  });

  /**
   * The defect. The bytes of the advisory are a real one: `rc`'s embedded-malware
   * compromise is CRITICAL and carries no CVSS vector, so OSV's group severity is the
   * empty string. Before the fix this printed `[UNSCORED]` and exited 0.
   */
  it("FAILS a CRITICAL advisory that carries NO CVSS vector", () => {
    const { status, output } = runGate(
      advisory({
        name: "rc",
        version: "1.2.8",
        id: "GHSA-g2q5-5433-rhrf",
        maxSeverity: "",
        label: "CRITICAL",
      }),
    );
    expect(status).toBe(1);
    expect(output).toContain("[CRITICAL]");
    expect(output).toContain("severity label");
    expect(output).not.toContain("[UNSCORED]");
  });

  it("FAILS a HIGH advisory that carries no CVSS vector", () => {
    const { status } = runGate(
      advisory({ name: "coa", id: "GHSA-73qr-pfmq-6rp8", maxSeverity: "", label: "HIGH" }),
    );
    expect(status).toBe(1);
  });

  /**
   * The over-block guard. Falling back to the label must not promote every unscored
   * advisory: a MODERATE one is still below the threshold and must not fail the gate,
   * or the fix trades a fail-open for a permanently red pipeline.
   */
  it("PASSES a MODERATE advisory that carries no CVSS vector", () => {
    const { status, output } = runGate(
      advisory({ name: "some-pkg", id: "GHSA-unscored-mod", maxSeverity: "", label: "MODERATE" }),
    );
    expect(status).toBe(0);
    expect(output).toContain("[MEDIUM]");
    expect(output).toContain("PASS:");
  });

  it("FAILS an advisory with neither a CVSS vector nor a severity label", () => {
    const { status, output } = runGate(
      advisory({ name: "mystery", id: "MAL-2026-9999", maxSeverity: "", label: null }),
    );
    expect(status).toBe(1);
    expect(output).toContain("[UNKNOWN]");
    expect(output).toContain("UNKNOWN");
  });

  /**
   * Identity, not content: the advisory bytes are held constant and only the ID moves
   * on and off the WAIVERS key. A gate that suppressed by severity rather than by
   * which advisory it is would stay green in both arms.
   *
   * The ID is **discovered from the workflow**, not hard-coded, and the arm skips when
   * no waiver is live. Hard-coding `GHSA-mh99-v99m-4gvg` made this test fail on a
   * wall-clock date with no code change: that waiver expires 2026-08-13, and its own
   * comment instructs deleting the entry on/after 2026-08-05 (tracked in #1211). A test
   * that goes red because a date passed teaches people to ignore it.
   */
  it("suppresses an unscored CRITICAL only when its ID matches a LIVE waiver", () => {
    const unscoredCritical = (id) =>
      advisory({ name: "waived-pkg", id, maxSeverity: "", label: "CRITICAL" });
    const fixture = { waivers: FIXTURE_WAIVERS, today: "2026-01-01" };

    const waived = runGate(unscoredCritical(FIXTURE_WAIVER_ID), fixture);
    expect(waived.status).toBe(0);
    expect(waived.output).toContain("WAIVED:");

    // One character different — a different advisory, identical severity and bytes.
    const notWaived = runGate(unscoredCritical("GHSA-fixt-ure0-0001"), fixture);
    expect(notWaived.status).toBe(1);
  });

  /**
   * The expiry mechanism itself, which nothing covered before: the same advisory, the
   * same waiver, and only the clock moved past `expires`. This is the whole point of a
   * time-boxed waiver, and it was previously asserted by nothing.
   */
  it("stops suppressing once the waiver's expiry date has passed", () => {
    const subject = advisory({
      name: "waived-pkg",
      id: FIXTURE_WAIVER_ID,
      maxSeverity: "",
      label: "CRITICAL",
    });

    const live = runGate(subject, { waivers: FIXTURE_WAIVERS, today: "2029-12-31" });
    expect(live.status).toBe(0);
    expect(live.output).toContain("WAIVED:");

    // One day past `expires: 2030-01-01`. Nothing else differs.
    const expired = runGate(subject, { waivers: FIXTURE_WAIVERS, today: "2030-01-02" });
    expect(expired.status).toBe(1);
    expect(expired.output).toContain("EXPIRED");
  });

  /**
   * The half of the waiver contract that holds no matter what the dict contains: an
   * advisory nobody waived, at or above the threshold, always breaches. This arm has no
   * wall-clock coupling at all, so it keeps the High-severity path pinned once every
   * waiver in the dict has expired and been deleted.
   */
  it("FAILS an unwaived High advisory regardless of what WAIVERS holds", () => {
    const { status } = runGate(
      advisory({ name: "unwaived-pkg", id: "GHSA-0000-0000-0000", maxSeverity: "7.5" }),
    );
    expect(status).toBe(1);
  });

  it("PASSES a clean scan", () => {
    const { status, output } = runGate({ results: [] });
    expect(status).toBe(0);
    expect(output).toContain("no known advisories");
  });

  /**
   * A FROZEN SNAPSHOT of what `osv-scanner` reported against this repository's
   * `pnpm-lock.yaml` on 2026-08-03 — the ten groups that scored below the threshold.
   * It is a realistic advisory set, not the live one: it cannot detect a newly-appearing
   * unscored advisory, and claiming it guards "on real data" would be an overclaim. What
   * it does pin is that the unscored-fails-closed rule leaves ordinary scored,
   * below-threshold advisories alone — the over-block direction, measured against shapes
   * that really occur rather than against invented ones.
   *
   * The two 7.5 `brace-expansion` rows are deliberately NOT here. They pass only because
   * a dated waiver is live, which would couple this arm to a calendar date; the waiver
   * path is covered by the two arms above instead.
   */
  it("PASSES a realistic below-threshold advisory set with no waiver in play", () => {
    const groups = [
      ["@hono/node-server", "1.19.14", "GHSA-frvp-7c67-39w9", "5.9"],
      ["@opentelemetry/core", "2.7.1", "GHSA-8988-4f7v-96qf", "5.3"],
      ["body-parser", "2.2.2", "GHSA-v422-hmwv-36x6", "3.7"],
      ["dompurify", "3.4.11", "GHSA-c2j3-45gr-mqc4", "2.1"],
      ["hono", "4.12.25", "GHSA-hvrm-45r6-mjfj", "6.5"],
      ["hono", "4.12.25", "GHSA-w62v-xxxg-mg59", "6.1"],
      ["hono", "4.12.25", "GHSA-xgm2-5f3f-mvvc", "4.8"],
      ["qs", "6.15.1", "GHSA-q8mj-m7cp-5q26", "6.3"],
      ["tar", "7.5.19", "GHSA-r292-9mhp-454m", "5.3"],
      ["valibot", "1.2.0", "GHSA-5qjj-4xww-7phc", "6.9"],
    ];
    const { status, output } = runGate({
      results: [
        {
          packages: groups.map(([name, version, id, maxSeverity]) => ({
            package: { name, version, ecosystem: "npm" },
            groups: [{ ids: [id], aliases: [id], max_severity: maxSeverity }],
            vulnerabilities: [{ id, database_specific: { severity: "MODERATE" } }],
          })),
        },
      ],
    });
    expect(status).toBe(0);
    expect(output).toContain("PASS:");
    expect(output).not.toContain("FAIL:");
  });
});
