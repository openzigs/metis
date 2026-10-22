import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  countByImage,
  evaluateGate,
  filterSarif,
  findingsFromReport,
  formatReport,
  isIsoDate,
  main,
  parseArgs,
  parseRetired,
  parseWaivers,
  reportProblems,
} from "./image-scan-gate.mjs";

/** #1379 — the policy over Trivy's image scan. See the module header. */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const TODAY = "2026-10-21";

/**
 * A minimal Trivy JSON report.
 * @param {Array<Record<string, string>>} vulns
 * @param {string} [target]
 */
function report(vulns, target = "img (debian 13.7)") {
  return {
    SchemaVersion: 2,
    Metadata: { OS: { Family: "debian", Name: "13.7" } },
    Results: [{ Target: target, Class: "os-pkgs", Vulnerabilities: vulns }],
  };
}

/** @param {Partial<Record<string,string>>} over */
function vuln(over = {}) {
  return {
    VulnerabilityID: "CVE-2026-0001",
    PkgName: "libfoo",
    InstalledVersion: "1.0",
    FixedVersion: "",
    Severity: "HIGH",
    ...over,
  };
}

/** @param {Partial<import("./image-scan-gate.mjs").Waiver>} over */
function waiver(over = {}) {
  return {
    id: "CVE-2026-0001",
    expires: "2027-01-19",
    reason: "no fix in the distro yet",
    ...over,
  };
}

describe("findingsFromReport", () => {
  it("keeps HIGH and CRITICAL, drops the rest", () => {
    const f = findingsFromReport(
      "server",
      report([
        vuln({ Severity: "LOW", VulnerabilityID: "a" }),
        vuln({ Severity: "MEDIUM", VulnerabilityID: "b" }),
        vuln({ Severity: "HIGH", VulnerabilityID: "c" }),
        vuln({ Severity: "CRITICAL", VulnerabilityID: "d" }),
        vuln({ Severity: "UNKNOWN", VulnerabilityID: "e" }),
      ]),
    );
    expect(f.map((x) => x.id)).toEqual(["c", "d"]);
    expect(f[0]).toMatchObject({
      image: "server",
      pkg: "libfoo",
      fixed: "",
      target: "img (debian 13.7)",
    });
  });

  it("de-duplicates a package Trivy lists once per file", () => {
    const f = findingsFromReport("ui", report([vuln(), vuln(), vuln({ InstalledVersion: "2.0" })]));
    expect(f).toHaveLength(2);
  });

  it("tolerates results with no Vulnerabilities and a clean report", () => {
    expect(findingsFromReport("ui", { Results: [{ Target: "x" }] })).toEqual([]);
    expect(findingsFromReport("ui", { Results: [] })).toEqual([]);
  });

  it("refuses something that is not a Trivy report rather than passing it as clean", () => {
    expect(() => findingsFromReport("ui", {})).toThrow(/not a Trivy JSON report/);
    expect(() => findingsFromReport("ui", null)).toThrow(/not a Trivy JSON report/);
  });

  it("reads a whitespace-only FixedVersion as no fix", () => {
    expect(findingsFromReport("ui", report([vuln({ FixedVersion: "  " })]))[0].fixed).toBe("");
  });
});

describe("evaluateGate", () => {
  /** @param {Partial<Record<string,string>>} over */
  const one = (over) => findingsFromReport("server", report([vuln(over)]));

  it("FAILS a fixable HIGH", () => {
    const r = evaluateGate(one({ FixedVersion: "1.1" }), [], TODAY);
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
  });

  it("FAILS a fixable CRITICAL", () => {
    const r = evaluateGate(one({ FixedVersion: "1.1", Severity: "CRITICAL" }), [], TODAY);
    expect(r.ok).toBe(false);
  });

  it("FAILS an unfixed CRITICAL with no waiver", () => {
    const r = evaluateGate(one({ Severity: "CRITICAL" }), [], TODAY);
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
  });

  it("only WARNS on an unfixed HIGH with no waiver", () => {
    const r = evaluateGate(one({}), [], TODAY);
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
  });

  it("a live waiver records an unfixed finding", () => {
    const r = evaluateGate(one({ Severity: "CRITICAL" }), [waiver()], TODAY);
    expect(r.ok).toBe(true);
    expect(r.waived).toHaveLength(1);
    expect(r.warnings).toHaveLength(0);
  });

  it("a waiver does NOT hide a fixable finding unless it says allowFixed", () => {
    expect(evaluateGate(one({ FixedVersion: "1.1" }), [waiver()], TODAY).ok).toBe(false);
    expect(
      evaluateGate(one({ FixedVersion: "1.1" }), [waiver({ allowFixed: true })], TODAY).ok,
    ).toBe(true);
  });

  it("an expired waiver FAILS while its finding is present — even an unfixed HIGH", () => {
    const r = evaluateGate(one({}), [waiver({ expires: TODAY })], TODAY);
    expect(r.ok).toBe(false);
    expect(r.expired).toHaveLength(1);
    // The day before expiry it still applies.
    expect(evaluateGate(one({}), [waiver({ expires: "2026-10-22" })], TODAY).ok).toBe(true);
  });

  it("an image-scoped waiver applies only to the images it names", () => {
    const findings = [
      ...findingsFromReport("server", report([vuln({ Severity: "CRITICAL" })])),
      ...findingsFromReport("ui", report([vuln({ Severity: "CRITICAL" })])),
    ];
    const r = evaluateGate(findings, [waiver({ images: ["server"] })], TODAY);
    expect(r.waived.map((w) => w.finding.image)).toEqual(["server"]);
    expect(r.failures.map((f) => f.image)).toEqual(["ui"]);
  });

  it("reports waivers that match nothing, without failing on them", () => {
    const r = evaluateGate([], [waiver({ id: "CVE-1999-0001" })], TODAY);
    expect(r.ok).toBe(true);
    expect(r.unused.map((w) => w.id)).toEqual(["CVE-1999-0001"]);
  });
});

describe("parseWaivers", () => {
  it("accepts a well-formed file", () => {
    expect(parseWaivers({ waivers: [waiver({ id: " CVE-2026-0001 " })] })[0].id).toBe(
      "CVE-2026-0001",
    );
  });

  it.each([
    [{}, /top-level `waivers` array/],
    [{ waivers: [null] }, /not an object/],
    [{ waivers: [{ expires: "2027-01-01", reason: "long enough reason" }] }, /missing id/],
    [{ waivers: [waiver({ expires: "next year" })] }, /YYYY-MM-DD/],
    [{ waivers: [waiver({ expires: "2027-13-45" })] }, /YYYY-MM-DD/],
    [{ waivers: [waiver({ reason: "" })] }, /reason is required/],
    [{ waivers: [{ ...waiver(), images: "server" }] }, /images must be a list/],
    [{ waivers: [{ ...waiver(), allowFixed: "yes" }] }, /allowFixed must be/],
  ])("rejects %j", (doc, message) => {
    expect(() => parseWaivers(doc)).toThrow(message);
  });

  it("the committed waiver file parses, and every entry has a future review date", () => {
    const doc = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".github/image-scan-waivers.json"), "utf8"),
    );
    const waivers = parseWaivers(doc);
    const today = new Date().toISOString().slice(0, 10);
    for (const w of waivers)
      expect(w.expires > today, `${w.id} review date ${w.expires} has passed`).toBe(true);
  });
});

describe("countByImage / formatReport", () => {
  const findings = [
    ...findingsFromReport(
      "server",
      report([vuln({ FixedVersion: "1.1" }), vuln({ VulnerabilityID: "x", Severity: "CRITICAL" })]),
    ),
    ...findingsFromReport("ui", report([])),
  ];

  it("counts per image, split by fixability", () => {
    expect(countByImage(findings, ["server", "ui"])).toEqual([
      { image: "server", high: 1, critical: 1, fixableHigh: 1, fixableCritical: 0 },
      { image: "ui", high: 0, critical: 0, fixableHigh: 0, fixableCritical: 0 },
    ]);
  });

  it("names every failure, expired waiver and warning", () => {
    const all = [
      ...findings,
      ...findingsFromReport(
        "ui",
        report([vuln({ VulnerabilityID: "w" }), vuln({ VulnerabilityID: "e" })]),
      ),
    ];
    const r = evaluateGate(
      all,
      [waiver({ id: "e", expires: "2026-01-01" }), waiver({ id: "gone" })],
      TODAY,
    );
    const text = formatReport(r, all, ["server", "ui"]);
    expect(text).toContain("| server | 1 | 1 | 1 | 0 |");
    expect(text).toContain("FAIL — 2 finding(s) that must be fixed");
    expect(text).toContain("CVE-2026-0001 libfoo 1.0 (fixed in 1.1)");
    expect(text).toContain("waiver expired 2026-01-01");
    expect(text).toContain("WARN — 1 unfixed HIGH");
    expect(text).toContain("NOTE: waiver gone matches no current finding");
    expect(text).toMatch(/\*\*FAIL\*\* — see above\.$/);
  });

  it("says PASS and counts the waived findings on a clean run", () => {
    const r = evaluateGate(findingsFromReport("ui", report([vuln()])), [waiver()], TODAY);
    const text = formatReport(r, [], ["ui"]);
    expect(text).toContain("Waived: 1 finding(s) under 1 live waiver(s).");
    expect(text).toMatch(/\*\*PASS\*\*/);
  });
});

describe("parseArgs", () => {
  it("parses waivers, labelled reports and an override date", () => {
    expect(
      parseArgs([
        "--waivers",
        "w.json",
        "--report",
        "ui=a=b.json",
        "--today",
        "2026-01-02",
        "--base-waivers",
        "base.json",
        "--sarif-dir",
        "out",
      ]),
    ).toEqual({
      waivers: "w.json",
      reports: [{ image: "ui", path: "a=b.json" }],
      today: "2026-01-02",
      baseWaivers: "base.json",
      sarifDir: "out",
    });
  });

  it.each([
    [["--report", "ui=a.json"], /--waivers/],
    [["--waivers", "w.json"], /at least one --report/],
    [["--waivers", "w.json", "--report", "noequals"], /unexpected argument/],
    [["--bogus"], /unexpected argument/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe("main and the CLI", () => {
  /** @type {string} */
  let dir;
  /** @type {string | undefined} */
  let summaryBefore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-scan-gate-"));
    summaryBefore = process.env.GITHUB_STEP_SUMMARY;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (summaryBefore === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = summaryBefore;
  });

  /** @param {string} name @param {unknown} value */
  const write = (name, value) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(value));
    return p;
  };

  it("returns 1 on a fixable finding and appends the job summary", () => {
    const w = write("w.json", { waivers: [] });
    const r = write("r.json", report([vuln({ FixedVersion: "1.1" })]));
    const summary = path.join(dir, "summary.md");
    process.env.GITHUB_STEP_SUMMARY = summary;
    expect(main(["--waivers", w, "--report", `ui=${r}`, "--today", TODAY])).toBe(1);
    expect(fs.readFileSync(summary, "utf8")).toContain("FAIL — 1 finding(s)");
  });

  it("returns 0 when everything is fixed or recorded", () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    const w = write("w.json", { waivers: [waiver()] });
    const r = write("r.json", report([vuln({ Severity: "CRITICAL" })]));
    expect(main(["--waivers", w, "--report", `ui=${r}`, "--today", TODAY])).toBe(0);
  });

  it("the CLI exits 1 on a breach and 2 on bad input", () => {
    const script = path.join(here, "image-scan-gate.mjs");
    const w = write("w.json", { waivers: [] });
    const bad = write("bad.json", report([vuln({ FixedVersion: "1.1" })]));
    const env = { ...process.env, GITHUB_STEP_SUMMARY: "" };
    /** @param {string[]} args */
    const run = (args) => {
      try {
        execFileSync(process.execPath, [script, ...args], { env, stdio: "pipe" });
        return 0;
      } catch (error) {
        return /** @type {{ status: number }} */ (error).status;
      }
    };
    expect(run(["--waivers", w, "--report", `ui=${bad}`])).toBe(1);
    expect(run(["--waivers", w, "--report", `ui=${path.join(dir, "missing.json")}`])).toBe(2);
    expect(run(["--waivers", w, "--report", `ui=${write("clean.json", report([]))}`])).toBe(0);
  });
});

describe("review of #1392 — fail closed, retired and deleted waivers, strict dates, SARIF", () => {
  describe("reportProblems", () => {
    it("accepts a report with an OS family and an os-pkgs result", () => {
      expect(reportProblems("ui", report([]))).toEqual([]);
    });

    it("fails a report whose OS was not detected", () => {
      const r = { ...report([]), Metadata: {} };
      expect(reportProblems("ui", r)).toEqual([
        "ui: Trivy detected no OS family, so no OS package was scanned",
      ]);
    });

    it("fails a report with no os-pkgs result (only language packages scanned)", () => {
      const r = { ...report([]), Results: [{ Target: "Node.js", Class: "lang-pkgs" }] };
      expect(reportProblems("ui", r)).toEqual([
        "ui: the report has no os-pkgs result, so OS packages were not scanned",
      ]);
    });

    it("fails an empty Results array, which is how a skipped OS scan looks", () => {
      expect(reportProblems("ui", { ...report([]), Results: [] })).toHaveLength(1);
    });

    it("fails an end-of-life distro release", () => {
      const r = {
        ...report([]),
        Metadata: { OS: { Family: "alpine", Name: "3.19.1", EOSL: true } },
      };
      expect(reportProblems("ui", r)[0]).toMatch(/alpine 3\.19\.1 is end-of-life/);
    });

    it("a report problem fails the gate even with zero findings", () => {
      const r = evaluateGate([], [], TODAY, { problems: ["ui: no OS"] });
      expect(r.ok).toBe(false);
      expect(formatReport(r, [], ["ui"])).toContain("report problem(s)");
    });
  });

  describe("isIsoDate", () => {
    it.each(["2027-01-19", "2028-02-29"])("accepts %s", (d) => expect(isIsoDate(d)).toBe(true));
    it.each(["2027-02-30", "2027-13-01", "2027-1-19", "next year", "", null, 20270119])(
      "rejects %j",
      (d) => expect(isIsoDate(d)).toBe(false),
    );

    it("an impossible expiry date is rejected by the waiver parser", () => {
      expect(() => parseWaivers({ waivers: [waiver({ expires: "2027-02-30" })] })).toThrow(
        /real YYYY-MM-DD/,
      );
    });

    it("an impossible --today is rejected", () => {
      expect(() =>
        parseArgs(["--waivers", "w", "--report", "a=b", "--today", "2026-02-30"]),
      ).toThrow(/unexpected argument/);
    });
  });

  describe("retired (`expired` section) and deleted waivers", () => {
    const retired = { id: "CVE-2026-0001", retired: "2026-10-01", reason: "expired; fix shipped" };
    /** @param {Partial<Record<string,string>>} over */
    const one = (over = {}) => findingsFromReport("server", report([vuln(over)]));

    it("parses the section, and absent means none", () => {
      expect(parseRetired({ waivers: [] })).toEqual([]);
      expect(parseRetired({ expired: [retired] })).toEqual([retired]);
    });

    it.each([
      [{ expired: {} }, /must be an array/],
      [{ expired: [null] }, /not an object/],
      [{ expired: [{ ...retired, id: "" }] }, /missing id/],
      [{ expired: [{ ...retired, retired: "2026-02-31" }] }, /real YYYY-MM-DD/],
      [{ expired: [{ ...retired, reason: "x" }] }, /reason is required/],
      [{ expired: [{ ...retired, images: [1] }] }, /images must be a list/],
    ])("rejects %j", (doc, message) => {
      expect(() => parseRetired(doc)).toThrow(message);
    });

    it("FAILS an unfixed HIGH whose waiver was retired — it no longer degrades to a WARN", () => {
      const r = evaluateGate(one(), [], TODAY, { retired: [retired] });
      expect(r.ok).toBe(false);
      expect(r.retired).toHaveLength(1);
      expect(r.warnings).toHaveLength(0);
      expect(formatReport(r, one(), ["server"])).toContain("waiver was retired to `expired`");
    });

    it("a live waiver re-instating a retired id wins", () => {
      expect(evaluateGate(one(), [waiver()], TODAY, { retired: [retired] }).ok).toBe(true);
    });

    it("FAILS when the change deleted a waiver the base branch had, for a present finding", () => {
      const r = evaluateGate(one(), [], TODAY, { baseWaivers: [waiver()] });
      expect(r.ok).toBe(false);
      expect(r.removed).toHaveLength(1);
      expect(formatReport(r, one(), ["server"])).toContain("whose waiver this change deleted");
    });

    it("moving the deleted waiver to `expired` reports it as retired instead", () => {
      const r = evaluateGate(one(), [], TODAY, { baseWaivers: [waiver()], retired: [retired] });
      expect(r.removed).toHaveLength(0);
      expect(r.retired).toHaveLength(1);
    });

    it("deleting a waiver whose finding is gone is fine", () => {
      expect(evaluateGate([], [], TODAY, { baseWaivers: [waiver()] }).ok).toBe(true);
    });
  });

  describe("filterSarif", () => {
    const sarif = {
      version: "2.1.0",
      runs: [{ tool: {}, results: [{ ruleId: "CVE-1" }, { ruleId: "CVE-2" }] }, { tool: {} }],
    };

    it("drops only the waived rule ids", () => {
      const out = filterSarif(sarif, new Set(["CVE-1"]));
      expect(out.runs[0].results).toEqual([{ ruleId: "CVE-2" }]);
      expect(out.runs[1].results).toEqual([]);
      expect(sarif.runs[0].results).toHaveLength(2);
    });

    it("refuses something that is not SARIF", () => {
      expect(() => filterSarif({}, new Set())).toThrow(/not a SARIF log/);
    });
  });

  describe("main with --base-waivers and --sarif-dir", () => {
    /** @type {string} */
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-scan-gate-review-"));
      delete process.env.GITHUB_STEP_SUMMARY;
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    /** @param {string} name @param {unknown} value */
    const write = (name, value) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, JSON.stringify(value));
      return p;
    };

    it("writes <label>.filtered.sarif without the waived results", () => {
      const w = write("w.json", { waivers: [waiver()] });
      const r = write("r.json", report([vuln(), vuln({ VulnerabilityID: "CVE-2026-0002" })]));
      write("ui.sarif", {
        runs: [{ results: [{ ruleId: "CVE-2026-0001" }, { ruleId: "CVE-2026-0002" }] }],
      });
      expect(
        main(["--waivers", w, "--report", `ui=${r}`, "--today", TODAY, "--sarif-dir", dir]),
      ).toBe(0);
      const out = JSON.parse(fs.readFileSync(path.join(dir, "ui.filtered.sarif"), "utf8"));
      expect(out.runs[0].results).toEqual([{ ruleId: "CVE-2026-0002" }]);
    });

    it("skips an image with no SARIF file", () => {
      const w = write("w.json", { waivers: [] });
      const r = write("r.json", report([]));
      expect(main(["--waivers", w, "--report", `ui=${r}`, "--sarif-dir", dir])).toBe(0);
      expect(fs.existsSync(path.join(dir, "ui.filtered.sarif"))).toBe(false);
    });

    it("returns 1 when a base-branch waiver was deleted for a present finding", () => {
      const w = write("w.json", { waivers: [] });
      const base = write("base.json", { waivers: [waiver()] });
      const r = write("r.json", report([vuln()]));
      expect(
        main(["--waivers", w, "--base-waivers", base, "--report", `ui=${r}`, "--today", TODAY]),
      ).toBe(1);
    });

    it("returns 1 on a report that scanned no OS packages", () => {
      const w = write("w.json", { waivers: [] });
      const r = write("r.json", { Results: [] });
      expect(main(["--waivers", w, "--report", `ui=${r}`])).toBe(1);
    });
  });
});
