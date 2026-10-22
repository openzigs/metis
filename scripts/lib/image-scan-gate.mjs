#!/usr/bin/env node
/**
 * #1379 — the gate over Trivy's scan of the built container images.
 *
 * K8S_PROD_CHECKLIST §9 asks for "High/Critical = 0", and until #1379 no CI job
 * scanned a built image at all: #1312 measured 58-92 HIGH and up to 7 CRITICAL per
 * image, most of them fixable. Trivy itself can only pass or fail on a severity
 * list, so the policy lives here, where it can be tested:
 *
 *   - FAIL  a HIGH or CRITICAL finding WITH a fixed version, unless a live waiver
 *           names it AND sets `allowFixed` (for a fix that genuinely cannot be
 *           installed yet, e.g. held by pnpm's 7-day `minimumReleaseAge`).
 *   - FAIL  a CRITICAL finding with NO fixed version and no live waiver.
 *   - FAIL  a waiver whose `expires` date has passed while its finding is still
 *           present. The date is a review date: on it, someone re-checks whether a
 *           fix exists and either removes the entry or re-dates it deliberately.
 *   - FAIL  a finding whose id is listed in the waiver file's `expired` section:
 *           a waiver taken out of `waivers` moves there, so deleting the record
 *           cannot turn an expired waiver's FAIL into a WARN (review of #1392).
 *   - FAIL  a finding whose waiver the base branch had and this change removed
 *           without moving it to `expired` (`--base-waivers`, on pull requests).
 *   - FAIL  a report that cannot be trusted to have scanned the OS packages: no
 *           detected OS family, no `os-pkgs` result, or an end-of-life distro
 *           release (Trivy then skips or no longer updates the OS data and exits 0,
 *           so "no findings" would mean "not looked").
 *   - WARN  a HIGH finding with no fixed version and no waiver. Debian and Alpine
 *           disclose unfixed HIGHs weekly; failing on each would turn `main` red
 *           with no code change and no action anyone can take. It is printed and
 *           annotated so it gets recorded, and it reaches code scanning as SARIF.
 *
 * NOT covered, by Trivy rather than by this gate: CVEs in the Node.js and CPython
 * runtimes of the official base images, which install them outside the distro's
 * package manager. A scan of node:22.1.0-alpine and python:3.12.0-slim reported
 * none. Those arrive only through base-image digest bumps (Dependabot `docker`).
 *
 * "Fixed version" is Trivy's `FixedVersion`. The images apply the distro's
 * security updates at build time (`apt-get upgrade` / `apk upgrade`, with the
 * layer cache busted daily by OS_PATCH_DATE), so a fix the distro has shipped is
 * already in the image; one still reported is a fix the image is not picking up.
 *
 * Waivers: `.github/image-scan-waivers.json` — see that file's `$comment`.
 *
 * Usage:
 *   node scripts/lib/image-scan-gate.mjs --waivers .github/image-scan-waivers.json \
 *     --report server=trivy-server.json --report ui=trivy-ui.json ... \
 *     [--base-waivers base.json] [--sarif-dir dir]
 * `--sarif-dir`: for each `<dir>/<label>.sarif`, write `<dir>/<label>.filtered.sarif`
 * without the results a live waiver covers, so code scanning does not open an alert
 * per recorded, unfixable finding.
 * Writes a Markdown summary to $GITHUB_STEP_SUMMARY when set. Exit 1 on any FAIL,
 * 2 on unusable input.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {"HIGH" | "CRITICAL"} GatedSeverity */

/**
 * @typedef {object} Finding
 * @property {string} image   label of the image the report came from
 * @property {string} id      vulnerability id (CVE-…, GHSA-…)
 * @property {string} pkg     package name
 * @property {string} installed
 * @property {string} fixed   Trivy's FixedVersion, "" when there is none
 * @property {string} severity
 * @property {string} target  Trivy result target (OS, or a language ecosystem)
 */

/**
 * @typedef {object} Waiver
 * @property {string} id
 * @property {string} expires   ISO date (YYYY-MM-DD); the waiver stops applying ON it
 * @property {string} reason
 * @property {string[]} [images] limit to these image labels; absent = every image
 * @property {boolean} [allowFixed] also suppress a finding that HAS a fixed version
 */

/**
 * @typedef {object} RetiredWaiver
 * @property {string} id
 * @property {string} retired   ISO date the waiver was taken out of `waivers`
 * @property {string} reason
 * @property {string[]} [images]
 */

/**
 * @typedef {object} GateResult
 * @property {Finding[]} failures         fixable HIGH/CRITICAL, or unfixed CRITICAL, unwaived
 * @property {Array<{finding: Finding, waiver: Waiver}>} expired  findings whose waiver lapsed
 * @property {Finding[]} warnings         unfixed HIGH with no waiver
 * @property {Array<{finding: Finding, waiver: Waiver}>} waived  suppressed by a live waiver
 * @property {Waiver[]} unused            waivers that match no current finding
 * @property {Array<{finding: Finding, retired: RetiredWaiver}>} retired  matches the `expired` section
 * @property {Array<{finding: Finding, waiver: Waiver}>} removed  waiver deleted since the base branch
 * @property {string[]} problems          reports that cannot be trusted (fail closed)
 * @property {boolean} ok
 */

const GATED = new Set(["HIGH", "CRITICAL"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar date in YYYY-MM-DD form. `Date.parse("2027-02-30")` is not NaN in
 * V8 (it rolls over to March 2), so the value must also survive a round trip.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * Reasons a report cannot be trusted to have scanned the image's OS packages.
 * Trivy logs a warning and exits 0 when it cannot detect the OS, or when its data
 * for the release is missing or end-of-life, and the report then simply lacks the
 * OS findings. Empty, here, would read as clean.
 *
 * @param {string} image
 * @param {unknown} report
 * @returns {string[]}
 */
export function reportProblems(image, report) {
  const r = /** @type {any} */ (report);
  const problems = [];
  const os = r?.Metadata?.OS;
  if (!os || typeof os.Family !== "string" || !os.Family) {
    problems.push(`${image}: Trivy detected no OS family, so no OS package was scanned`);
  } else if (os.EOSL === true) {
    problems.push(
      `${image}: ${os.Family} ${os.Name ?? ""} is end-of-life in Trivy's data; its OS findings are no longer maintained`,
    );
  }
  const results = Array.isArray(r?.Results) ? r.Results : [];
  if (!results.some((/** @type {any} */ x) => x?.Class === "os-pkgs")) {
    problems.push(`${image}: the report has no os-pkgs result, so OS packages were not scanned`);
  }
  return problems;
}

/**
 * Flatten one Trivy JSON report into gated findings, de-duplicated on
 * (image, id, pkg, installed) — Trivy lists a package once per file it was found in.
 *
 * @param {string} image
 * @param {unknown} report parsed `trivy image --format json` output
 * @returns {Finding[]}
 */
export function findingsFromReport(image, report) {
  if (
    !report ||
    typeof report !== "object" ||
    !Array.isArray(/** @type {any} */ (report).Results)
  ) {
    throw new Error(`${image}: not a Trivy JSON report (no Results array)`);
  }
  /** @type {Map<string, Finding>} */
  const seen = new Map();
  for (const result of /** @type {any[]} */ (/** @type {any} */ (report).Results)) {
    for (const v of result?.Vulnerabilities ?? []) {
      const severity = String(v?.Severity ?? "").toUpperCase();
      if (!GATED.has(severity)) continue;
      const finding = {
        image,
        id: String(v.VulnerabilityID ?? ""),
        pkg: String(v.PkgName ?? ""),
        installed: String(v.InstalledVersion ?? ""),
        fixed: String(v.FixedVersion ?? "").trim(),
        severity,
        target: String(result.Target ?? ""),
      };
      const key = [finding.image, finding.id, finding.pkg, finding.installed].join("\u0000");
      if (!seen.has(key)) seen.set(key, finding);
    }
  }
  return [...seen.values()];
}

/**
 * Validate the waiver file's shape. A malformed entry is an error, not a skip:
 * a typo'd date that silently never expires is the failure this file exists to
 * prevent.
 *
 * @param {unknown} doc
 * @returns {Waiver[]}
 */
export function parseWaivers(doc) {
  const list = /** @type {any} */ (doc)?.waivers;
  if (!Array.isArray(list)) throw new Error("waiver file: expected a top-level `waivers` array");
  return list.map((w, i) => {
    const where = `waivers[${i}]`;
    if (!w || typeof w !== "object") throw new Error(`${where}: not an object`);
    if (typeof w.id !== "string" || !w.id.trim()) throw new Error(`${where}: missing id`);
    if (!isIsoDate(w.expires)) {
      throw new Error(`${where} (${w.id}): expires must be a real YYYY-MM-DD date`);
    }
    if (typeof w.reason !== "string" || w.reason.trim().length < 10) {
      throw new Error(`${where} (${w.id}): a reason is required`);
    }
    if (
      w.images !== undefined &&
      !(
        Array.isArray(w.images) &&
        w.images.every((/** @type {unknown} */ x) => typeof x === "string")
      )
    ) {
      throw new Error(`${where} (${w.id}): images must be a list of image labels`);
    }
    if (w.allowFixed !== undefined && typeof w.allowFixed !== "boolean") {
      throw new Error(`${where} (${w.id}): allowFixed must be true or false`);
    }
    return /** @type {Waiver} */ ({ ...w, id: w.id.trim() });
  });
}

/**
 * The waiver file's optional `expired` section: waivers taken out of `waivers`.
 * Any finding still matching one FAILS, so removing the record is never a way to
 * clear a red build; only a fix, or a deliberate re-instatement in `waivers`, is.
 *
 * @param {unknown} doc
 * @returns {RetiredWaiver[]}
 */
export function parseRetired(doc) {
  const list = /** @type {any} */ (doc)?.expired;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error("waiver file: `expired` must be an array");
  return list.map((w, i) => {
    const where = `expired[${i}]`;
    if (!w || typeof w !== "object") throw new Error(`${where}: not an object`);
    if (typeof w.id !== "string" || !w.id.trim()) throw new Error(`${where}: missing id`);
    if (!isIsoDate(w.retired)) {
      throw new Error(`${where} (${w.id}): retired must be a real YYYY-MM-DD date`);
    }
    if (typeof w.reason !== "string" || w.reason.trim().length < 10) {
      throw new Error(`${where} (${w.id}): a reason is required`);
    }
    if (
      w.images !== undefined &&
      !(
        Array.isArray(w.images) &&
        w.images.every((/** @type {unknown} */ x) => typeof x === "string")
      )
    ) {
      throw new Error(`${where} (${w.id}): images must be a list of image labels`);
    }
    return /** @type {RetiredWaiver} */ ({ ...w, id: w.id.trim() });
  });
}

/**
 * @param {{ id: string, images?: string[] }} waiver
 * @param {Finding} finding
 */
function waiverMatches(waiver, finding) {
  if (waiver.id !== finding.id) return false;
  return !waiver.images || waiver.images.includes(finding.image);
}

/**
 * @param {Waiver} waiver
 * @param {string} today YYYY-MM-DD
 */
function isLive(waiver, today) {
  return today < waiver.expires;
}

/**
 * Apply the policy in this file's header.
 *
 * @param {Finding[]} findings
 * @param {Waiver[]} waivers
 * @param {string} today YYYY-MM-DD (UTC)
 * @param {{ retired?: RetiredWaiver[], baseWaivers?: Waiver[], problems?: string[] }} [extra]
 * @returns {GateResult}
 */
export function evaluateGate(findings, waivers, today, extra = {}) {
  const retiredList = extra.retired ?? [];
  const baseWaivers = extra.baseWaivers ?? [];
  const keptIds = new Set([...waivers, ...retiredList].map((w) => w.id));
  /** @type {GateResult} */
  const result = {
    failures: [],
    expired: [],
    warnings: [],
    waived: [],
    unused: [],
    retired: [],
    removed: [],
    problems: [...(extra.problems ?? [])],
    ok: true,
  };
  /** @type {Set<Waiver>} */
  const used = new Set();

  for (const finding of findings) {
    const fixable = finding.fixed !== "";
    const matching = waivers.filter((w) => waiverMatches(w, finding));
    for (const w of matching) used.add(w);
    const live = matching.find((w) => isLive(w, today) && (!fixable || w.allowFixed === true));
    if (live) {
      result.waived.push({ finding, waiver: live });
      continue;
    }
    const lapsed = matching.find((w) => !isLive(w, today));
    if (lapsed) {
      result.expired.push({ finding, waiver: lapsed });
      continue;
    }
    const retired = retiredList.find((w) => waiverMatches(w, finding));
    if (retired) {
      result.retired.push({ finding, retired });
      continue;
    }
    const removed = baseWaivers.find((w) => !keptIds.has(w.id) && waiverMatches(w, finding));
    if (removed) {
      result.removed.push({ finding, waiver: removed });
      continue;
    }
    if (fixable || finding.severity === "CRITICAL") {
      result.failures.push(finding);
    } else {
      result.warnings.push(finding);
    }
  }

  result.unused = waivers.filter((w) => !used.has(w));
  result.ok =
    result.failures.length === 0 &&
    result.expired.length === 0 &&
    result.retired.length === 0 &&
    result.removed.length === 0 &&
    result.problems.length === 0;
  return result;
}

/** @param {Finding} f */
const describe = (f) =>
  `${f.image}: ${f.severity} ${f.id} ${f.pkg} ${f.installed}` +
  (f.fixed ? ` (fixed in ${f.fixed})` : " (no fix available)");

/**
 * Per-image HIGH/CRITICAL counts, split by whether a fix exists.
 *
 * @param {Finding[]} findings
 * @param {string[]} images
 */
export function countByImage(findings, images) {
  return images.map((image) => {
    const mine = findings.filter((f) => f.image === image);
    const count = (/** @type {string} */ sev, /** @type {boolean} */ fixable) =>
      mine.filter((f) => f.severity === sev && (f.fixed !== "") === fixable).length;
    return {
      image,
      high: mine.filter((f) => f.severity === "HIGH").length,
      critical: mine.filter((f) => f.severity === "CRITICAL").length,
      fixableHigh: count("HIGH", true),
      fixableCritical: count("CRITICAL", true),
    };
  });
}

/**
 * Human-readable report: the per-image table, then every FAIL, expired waiver and
 * WARN. Markdown, so the same text serves the log and the job summary.
 *
 * @param {GateResult} result
 * @param {Finding[]} findings
 * @param {string[]} images
 */
export function formatReport(result, findings, images) {
  const lines = [
    "### Container image scan (Trivy, HIGH/CRITICAL) — #1379",
    "",
    "| Image | HIGH | CRITICAL | fixable HIGH | fixable CRITICAL |",
    "|---|---|---|---|---|",
    ...countByImage(findings, images).map(
      (c) => `| ${c.image} | ${c.high} | ${c.critical} | ${c.fixableHigh} | ${c.fixableCritical} |`,
    ),
    "",
  ];
  if (result.problems.length) {
    lines.push(`**FAIL — ${result.problems.length} report problem(s): scan not trustworthy:**`, "");
    for (const p of result.problems) lines.push(`- ${p}`);
    lines.push("");
  }
  if (result.failures.length) {
    lines.push(`**FAIL — ${result.failures.length} finding(s) that must be fixed:**`, "");
    for (const f of result.failures) lines.push(`- ${describe(f)}`);
    lines.push(
      "",
      "Rebuild on a patched base (bump the digest), upgrade the package, or remove it from the " +
        "runtime image. Only a fix that cannot be installed yet may be waived, with `allowFixed` " +
        "and a near `expires` date in `.github/image-scan-waivers.json`.",
      "",
    );
  }
  if (result.expired.length) {
    lines.push(`**FAIL — ${result.expired.length} finding(s) whose waiver has expired:**`, "");
    for (const { finding, waiver } of result.expired) {
      lines.push(`- ${describe(finding)} — waiver expired ${waiver.expires}: ${waiver.reason}`);
    }
    lines.push(
      "",
      "Re-check for a fix. If the fix is in, rebuild and move the entry to `expired`; if not, " +
        "re-date it deliberately. Deleting the entry does not clear this.",
      "",
    );
  }
  if (result.retired.length) {
    lines.push(
      `**FAIL — ${result.retired.length} finding(s) whose waiver was retired to \`expired\`:**`,
      "",
    );
    for (const { finding, retired } of result.retired) {
      lines.push(`- ${describe(finding)} — retired ${retired.retired}: ${retired.reason}`);
    }
    lines.push("", "Fix it, or re-instate the waiver in `waivers` with a new review date.", "");
  }
  if (result.removed.length) {
    lines.push(
      `**FAIL — ${result.removed.length} finding(s) whose waiver this change deleted:**`,
      "",
    );
    for (const { finding, waiver } of result.removed) {
      lines.push(`- ${describe(finding)} — the base branch waived ${waiver.id}`);
    }
    lines.push(
      "",
      "A waiver leaves `waivers` only by moving to `expired`, and the finding must be gone.",
      "",
    );
  }
  if (result.warnings.length) {
    lines.push(
      `**WARN — ${result.warnings.length} unfixed HIGH finding(s) not yet recorded** ` +
        "(no fix exists; record each in `.github/image-scan-waivers.json` with a review date):",
      "",
    );
    for (const f of result.warnings) lines.push(`- ${describe(f)}`);
    lines.push("");
  }
  if (result.waived.length) {
    const ids = [...new Set(result.waived.map((w) => w.waiver.id))];
    lines.push(
      `Waived: ${result.waived.length} finding(s) under ${ids.length} live waiver(s).`,
      "",
    );
  }
  for (const w of result.unused) {
    lines.push(`NOTE: waiver ${w.id} matches no current finding — it can be deleted.`);
  }
  lines.push(
    "",
    result.ok
      ? "**PASS** — no fixable HIGH/CRITICAL, no unwaived CRITICAL, no expired, retired or " +
          "deleted waiver, and every report scanned its OS packages."
      : "**FAIL** — see above.",
  );
  return lines.join("\n");
}

/**
 * A copy of a Trivy SARIF log without the results whose rule id is in `ids` (the
 * live-waived vulnerability ids for that image).
 *
 * @param {any} sarif
 * @param {Set<string>} ids
 */
export function filterSarif(sarif, ids) {
  if (!sarif || !Array.isArray(sarif.runs)) throw new Error("not a SARIF log (no runs array)");
  return {
    ...sarif,
    runs: sarif.runs.map((/** @type {any} */ run) => ({
      ...run,
      results: (run.results ?? []).filter((/** @type {any} */ r) => !ids.has(String(r.ruleId))),
    })),
  };
}

/**
 * @param {string[]} argv
 * @returns {{ waivers: string, reports: Array<{image: string, path: string}>, today: string,
 *   baseWaivers: string, sarifDir: string }}
 */
export function parseArgs(argv) {
  /** @type {Array<{image: string, path: string}>} */
  const reports = [];
  let waivers = "";
  let baseWaivers = "";
  let sarifDir = "";
  let today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--waivers" && value) {
      waivers = value;
      i += 1;
    } else if (arg === "--report" && value && value.includes("=")) {
      const at = value.indexOf("=");
      reports.push({ image: value.slice(0, at), path: value.slice(at + 1) });
      i += 1;
    } else if (arg === "--today" && isIsoDate(value)) {
      today = value;
      i += 1;
    } else if (arg === "--base-waivers" && value) {
      baseWaivers = value;
      i += 1;
    } else if (arg === "--sarif-dir" && value) {
      sarifDir = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (!waivers) throw new Error("--waivers <file> is required");
  if (reports.length === 0)
    throw new Error("at least one --report <image>=<trivy.json> is required");
  return { waivers, reports, today, baseWaivers, sarifDir };
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  const args = parseArgs(argv);
  const doc = JSON.parse(readFileSync(args.waivers, "utf8"));
  const waivers = parseWaivers(doc);
  const retired = parseRetired(doc);
  const baseWaivers = args.baseWaivers
    ? parseWaivers(JSON.parse(readFileSync(args.baseWaivers, "utf8")))
    : [];
  /** @type {string[]} */
  const problems = [];
  const findings = args.reports.flatMap(({ image, path: file }) => {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const found = findingsFromReport(image, parsed);
    problems.push(...reportProblems(image, parsed));
    return found;
  });
  const images = args.reports.map((r) => r.image);
  const result = evaluateGate(findings, waivers, args.today, { retired, baseWaivers, problems });
  if (args.sarifDir) {
    for (const image of images) {
      const input = path.join(args.sarifDir, `${image}.sarif`);
      if (!existsSync(input)) continue;
      const ids = new Set(
        result.waived.filter((w) => w.finding.image === image).map((w) => w.finding.id),
      );
      const filtered = filterSarif(JSON.parse(readFileSync(input, "utf8")), ids);
      writeFileSync(path.join(args.sarifDir, `${image}.filtered.sarif`), JSON.stringify(filtered));
    }
  }
  const report = formatReport(result, findings, images);
  console.log(report);
  for (const f of result.failures) console.log(`::error title=image scan (#1379)::${describe(f)}`);
  for (const { finding, waiver } of result.expired) {
    console.log(
      `::error title=image scan waiver expired (#1379)::${describe(finding)} — waiver expired ${waiver.expires}`,
    );
  }
  for (const p of result.problems) console.log(`::error title=image scan (#1379)::${p}`);
  for (const { finding } of [...result.retired, ...result.removed]) {
    console.log(`::error title=image scan waiver removed (#1379)::${describe(finding)}`);
  }
  for (const f of result.warnings)
    console.log(`::warning title=image scan (#1379)::${describe(f)}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `::error title=image scan gate (#1379)::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
