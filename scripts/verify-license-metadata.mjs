#!/usr/bin/env node
/**
 * Fail the build if a manifest's licence metadata drifts from the #1296 decision.
 *
 * Runs as part of `pnpm lint`, so it executes in every CI job that lints as well as
 * on every local gate — the same wiring the sibling NUL (#1215) and
 * company-identifier (#1373) gates use.
 *
 * Two things it asserts that nothing else does:
 *
 *   * every tracked `package.json` declares `"license": "AGPL-3.0-only"` — `-only`,
 *     never `-or-later`, which is the choice #1296 made deliberately so no future FSF
 *     version gains authority over these terms;
 *   * every tracked `package.json` has been **reviewed** for publication and its
 *     `private` flag matches that review. The register lives in
 *     `lib/license-metadata-core.mjs` with a reason per package, and a manifest that
 *     is not in it fails — which is what makes the eleventh package, six weeks from
 *     now, impossible to add unnoticed.
 *
 * Scope: tracked files only, via `git ls-files`, so no `node_modules` manifest and no
 * untracked ingest directory can enter the domain.
 *
 * Usage:
 *   node scripts/verify-license-metadata.mjs
 *
 * Exit codes: 0 clean, 1 a problem was found or a tracked manifest could not be read.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { auditLicenseMetadata, formatReport, isClean } from "./lib/license-metadata-core.mjs";
import { chdirToRepoRoot } from "./lib/repo-root.mjs";

/** @returns {string[]} every tracked package.json, repo-relative */
function trackedManifests() {
  const out = execFileSync("git", ["ls-files", "-z", "*package.json"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && !path.includes("node_modules/"))
    .sort();
}

/**
 * Read one tracked manifest.
 *
 * A path that is tracked but absent from this worktree, or unreadable for any other
 * reason, yields `null` — which the audit treats as a FAILURE rather than a skip. A
 * gate that silently passes over the one file it could not open is the fail-open
 * shape #1215 measured on the sibling NUL gate.
 *
 * @param {string} path
 * @returns {string | null}
 */
function readManifest(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

chdirToRepoRoot("verify-license-metadata");

const manifests = trackedManifests().map((path) => ({ path, text: readManifest(path) }));
const result = auditLicenseMetadata({ manifests });
const report = formatReport(result);

if (isClean(result)) {
  console.log(report);
  process.exit(0);
}

console.error(report);
process.exit(1);
