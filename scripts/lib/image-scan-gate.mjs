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
 *   - WARN  a HIGH finding with no fixed version and no waiver. Debian and Alpine
 *           disclose unfixed HIGHs weekly; failing on each would turn `main` red
 *           with no code change and no action anyone can take. It is printed and
 *           annotated so it gets recorded, and it reaches code scanning as SARIF.
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
 *     --report server=trivy-server.json --report ui=trivy-ui.json ...
 * Writes a Markdown summary to $GITHUB_STEP_SUMMARY when set. Exit 1 on any FAIL.
 */

import { appendFileSync, readFileSync } from "node:fs";
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
 * @typedef {object} GateResult
 * @property {Finding[]} failures         fixable HIGH/CRITICAL, or unfixed CRITICAL, unwaived
 * @property {Array<{finding: Finding, waiver: Waiver}>} expired  findings whose waiver lapsed
 * @property {Finding[]} warnings         unfixed HIGH with no waiver
 * @property {Array<{finding: Finding, waiver: Waiver}>} waived  suppressed by a live waiver
 * @property {Waiver[]} unused            waivers that match no current finding
 * @property {boolean} ok
 */

const GATED = new Set(["HIGH", "CRITICAL"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    if (
      typeof w.expires !== "string" ||
      !ISO_DATE.test(w.expires) ||
      Number.isNaN(Date.parse(w.expires))
    ) {
      throw new Error(`${where} (${w.id}): expires must be a YYYY-MM-DD date`);
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
 * @param {Waiver} waiver
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
 * @returns {GateResult}
 */
export function evaluateGate(findings, waivers, today) {
  /** @type {GateResult} */
  const result = { failures: [], expired: [], warnings: [], waived: [], unused: [], ok: true };
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
    if (fixable || finding.severity === "CRITICAL") {
      result.failures.push(finding);
    } else {
      result.warnings.push(finding);
    }
  }

  result.unused = waivers.filter((w) => !used.has(w));
  result.ok = result.failures.length === 0 && result.expired.length === 0;
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
    lines.push("", "Re-check for a fix; remove the waiver, or re-date it deliberately.", "");
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
      ? "**PASS** — no fixable HIGH/CRITICAL, no unwaived CRITICAL, no expired waiver."
      : "**FAIL** — see above.",
  );
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 * @returns {{ waivers: string, reports: Array<{image: string, path: string}>, today: string }}
 */
export function parseArgs(argv) {
  /** @type {Array<{image: string, path: string}>} */
  const reports = [];
  let waivers = "";
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
    } else if (arg === "--today" && value && ISO_DATE.test(value)) {
      today = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (!waivers) throw new Error("--waivers <file> is required");
  if (reports.length === 0)
    throw new Error("at least one --report <image>=<trivy.json> is required");
  return { waivers, reports, today };
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  const args = parseArgs(argv);
  const waivers = parseWaivers(JSON.parse(readFileSync(args.waivers, "utf8")));
  const findings = args.reports.flatMap(({ image, path }) =>
    findingsFromReport(image, JSON.parse(readFileSync(path, "utf8"))),
  );
  const images = args.reports.map((r) => r.image);
  const result = evaluateGate(findings, waivers, args.today);
  const report = formatReport(result, findings, images);
  console.log(report);
  for (const f of result.failures) console.log(`::error title=image scan (#1379)::${describe(f)}`);
  for (const { finding, waiver } of result.expired) {
    console.log(
      `::error title=image scan waiver expired (#1379)::${describe(finding)} — waiver expired ${waiver.expires}`,
    );
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
