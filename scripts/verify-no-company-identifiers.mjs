#!/usr/bin/env node
/**
 * Fail the build if private vocabulary reappears in the publishable tree.
 *
 * Runs as part of `pnpm lint`, so it executes in every CI job that lints as well as on
 * every local gate — the same wiring the sibling NUL gate uses.
 *
 * Scope: every tracked file except the legitimately binary ones, plus every tracked
 * PATH. There is no path exclusion list (#1382). Everything read is scanned, including
 * this file and the gate's own tests.
 *
 * ## The term list lives outside the repository
 *
 * See `lib/company-identifiers-core.mjs` for why. It is resolved from, in order:
 * `METIS_PRIVATE_TERMS` (the list; CI passes a repository secret),
 * `METIS_PRIVATE_TERMS_FILE`, `<repo>/.private-terms` (gitignored), and
 * `~/.config/metis/private-terms.txt`.
 *
 * ## When no list is configured
 *
 * Outside contributors and fork pull requests cannot hold the list, and must still be
 * able to run `pnpm lint`. So an unconfigured gate SKIPS — loudly, as a line that says
 * nothing was checked, never as a line that says nothing was found. Wherever the list
 * is supposed to exist, `METIS_REQUIRE_PRIVATE_TERMS=1` turns that skip into a failure:
 * ci.yml sets it for pushes and same-repository pull requests, where a missing secret
 * means the gate has been silently disarmed rather than legitimately withheld.
 *
 * Usage:
 *   node scripts/verify-no-company-identifiers.mjs
 *
 * Exit codes: 0 clean (or skipped, not required); 1 term found, a tracked file could
 * not be read, the list parsed to zero terms, or the list is required and absent.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatReport,
  isClean,
  parseTerms,
  resolveTermSource,
  scanFiles,
  termsRequired,
} from "./lib/company-identifiers-core.mjs";
import { chdirToRepoRoot } from "./lib/repo-root.mjs";

/*
 * The anchoring this gate introduced in #1380 now lives in `lib/repo-root.mjs`, shared
 * with the sibling NUL gate. Two private copies of the same policy is how two gates
 * drift apart, and #1381 asks for them to agree on what happens outside a checkout —
 * one implementation is the only agreement that cannot rot. The rationale for both the
 * anchor and the fail-loud-outside-a-repository decision is in that module's header.
 */

/** @returns {string[]} every tracked path, repo-relative with forward slashes */
function tracked() {
  const out = execFileSync("git", ["ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 });
  return out
    .toString("utf8")
    .split("\0")
    .filter((file) => file.length > 0);
}

/**
 * Read one tracked path the way git stores it.
 *
 * A symlink's blob is the link TEXT, not the target's bytes: `.claude/skills/*` are 14
 * tracked symlinks to directories, and following them throws EISDIR on every one
 * (#1215). `lstat` therefore decides. A path that is tracked but absent from this
 * worktree returns `null` — nothing is there to contain anything, which is a knowable
 * answer and not the same as "could not be read".
 *
 * @param {string} file
 * @returns {string | null}
 */
function readTracked(file) {
  let entry;
  try {
    entry = lstatSync(file);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
  if (entry.isSymbolicLink()) return readlinkSync(file);
  if (entry.isFile()) return readFileSync(file, "utf8");
  throw new Error(
    `the index records a blob, but the worktree holds a ${
      entry.isDirectory() ? "directory" : "non-regular file"
    }`,
  );
}

/**
 * @param {string} file
 * @returns {string | null} null when the file does not exist
 */
function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
}

chdirToRepoRoot("verify-no-company-identifiers");

// `HOME` is read from the environment rather than `os.homedir()` alone so a test can
// point the fallback somewhere empty instead of inheriting the developer's real list.
const home = process.env.HOME ?? os.homedir();
const resolved = resolveTermSource({
  env: process.env,
  readOptional,
  repoFile: path.resolve(".private-terms"),
  homeFile: home ? path.join(home, ".config", "metis", "private-terms.txt") : null,
});

if (resolved === null) {
  if (termsRequired(process.env)) {
    console.error(
      "verify-no-company-identifiers: METIS_REQUIRE_PRIVATE_TERMS is set but no term list " +
        "was found. NOTHING WAS CHECKED. In CI this means the METIS_PRIVATE_TERMS secret " +
        "is missing or empty — restore it; do not unset the requirement.",
    );
    process.exit(1);
  }
  console.log(
    "verify-no-company-identifiers: SKIPPED — no private term list is configured, so " +
      "nothing was checked. This is expected for outside contributors; the maintainers' " +
      "CI runs the real check.",
  );
  process.exit(0);
}

const result = scanFiles({
  files: tracked(),
  readFile: readTracked,
  terms: parseTerms(resolved.raw),
});

const report = formatReport(result, resolved.source);
if (isClean(result)) {
  console.log(report.join("\n"));
  process.exit(0);
}

console.error(report.join("\n"));
process.exit(1);
