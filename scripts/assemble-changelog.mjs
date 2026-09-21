#!/usr/bin/env node
/**
 * `pnpm changelog:assemble <version>` — fold every unreleased fragment into
 * `CHANGELOG.md` under a new version heading and delete them (Issue #1191).
 *
 * Thin I/O glue only: it reads the fragments and `CHANGELOG.md`, hands them to
 * the pure logic in `lib/changelog-fragments-core.mjs`, writes the result and
 * removes the consumed files.
 *
 * Usage:
 *   node scripts/assemble-changelog.mjs 1.1.0 [--date YYYY-MM-DD] [--dry-run]
 *
 * Exit codes:
 *   0  the section was assembled (or printed, under --dry-run)
 *   1  no fragments, a malformed fragment, or a bad version/date
 *
 * This runs when a maintainer cuts a tagged release. It deliberately does NOT
 * bump any `package.json` version and does not touch the existing
 * `## [Unreleased]` body — #1191 migrates forward and leaves the 996 legacy
 * entries where they are.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FRAGMENT_DIR,
  insertVersionSection,
  isFragmentBasename,
  parseFragment,
  renderVersionSection,
} from "./lib/changelog-fragments-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fragmentRoot = path.join(repoRoot, ...FRAGMENT_DIR.split("/"));
const changelogPath = path.join(repoRoot, "CHANGELOG.md");

/** @param {string[]} argv */
function parseArgs(argv) {
  const positional = [];
  let date = new Date().toISOString().slice(0, 10);
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--date") date = argv[(i += 1)] ?? "";
    else if (arg.startsWith("--date=")) date = arg.slice("--date=".length);
    else positional.push(arg);
  }
  return { version: positional[0], date, dryRun };
}

function main() {
  const { version, date, dryRun } = parseArgs(process.argv.slice(2));
  if (!version) {
    console.error(
      "Usage: node scripts/assemble-changelog.mjs <version> [--date YYYY-MM-DD] [--dry-run]",
    );
    process.exit(1);
  }

  let names = [];
  try {
    // Same predicate as the gate and as the diff side. Three hand-rolled copies
    // of this filter is what let a file count as a fragment for one of them and
    // not for another.
    names = fs.readdirSync(fragmentRoot).filter(isFragmentBasename).sort();
  } catch {
    console.error(`No ${FRAGMENT_DIR}/ directory — nothing to assemble.`);
    process.exit(1);
  }

  if (names.length === 0) {
    console.error(`No fragments in ${FRAGMENT_DIR}/ — nothing to assemble.`);
    process.exit(1);
  }

  const fragments = names.map((name) =>
    parseFragment(name, fs.readFileSync(path.join(fragmentRoot, name), "utf8")),
  );
  const problems = fragments.flatMap((fragment) => fragment.problems);
  if (problems.length > 0) {
    console.error("Refusing to assemble — some fragments are malformed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  let rendered;
  try {
    rendered = renderVersionSection({ fragments, version, date });
  } catch (error) {
    console.error(`Refusing to assemble — ${error.message}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(rendered);
    console.log(`--dry-run: ${fragments.length} fragment(s) would be consumed and deleted.`);
    return;
  }

  const changelog = fs.readFileSync(changelogPath, "utf8");
  fs.writeFileSync(changelogPath, insertVersionSection(changelog, rendered), "utf8");
  for (const name of names) fs.rmSync(path.join(fragmentRoot, name));

  console.log(
    `Assembled ${fragments.length} fragment(s) into CHANGELOG.md and removed them from ${FRAGMENT_DIR}/.`,
  );
  console.log("Review the diff, then tag the release. No package.json version was changed.");
}

main();
