import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Every `git ls-files` gate must answer about the REPOSITORY, not about the caller's
 * working directory (#1381).
 *
 * ## Why this is derived rather than listed
 *
 * The issue's scope was established by running four gates from the root and from
 * `server/` and diffing the output — a one-off measurement that expires the moment a
 * fifth gate is written. A hand-maintained list of four would pass forever while a new
 * gate shipped the same defect beside it, which is this repository's most-repeated
 * failure shape: the gate that cannot fail (#1168, #1215, #1270).
 *
 * So the list is COMPUTED, from the two sources that decide what actually runs:
 *
 *   1. `package.json` scripts — every `node scripts/**\/*.mjs` entry point. A gate
 *      nobody can invoke is not a gate.
 *   2. the entry point's own source plus its relative `.mjs` imports, with comments
 *      stripped — does it CALL `git ls-files`? Comments must go: three core modules
 *      merely discuss `git ls-files` in prose and would otherwise be swept in.
 *
 * The derivation is then itself pinned: the four gates measured in #1381 must still be
 * found by name, so a rename or a deletion fails here rather than silently shrinking
 * the set to nothing (a `length >= 4` guard would not notice a rename).
 *
 * ## What the comparison asserts
 *
 * Byte-identical stdout, stderr and exit status from the repository root and from
 * `server/src`. Not merely "both green": before the fix, both invocations of
 * `check-no-nul` exited 0 and the only difference was the file count in a success line,
 * which is exactly the difference a human does not read.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Two levels down, and the directory where the defect was originally measured. */
const SUBDIR = path.join(repoRoot, "server", "src");

/**
 * The four gates #1381 measured. Named so the derivation cannot quietly stop finding
 * them; the comparison below runs over whatever it DOES find, so a fifth gate is
 * covered automatically without editing this file.
 */
const MEASURED_IN_1381 = [
  "scripts/lib/check-no-nul.mjs",
  "scripts/verify-no-company-identifiers.mjs",
  "scripts/verify-agent-frontmatter.mjs",
  "scripts/verify-skill-links.mjs",
];

/** The two gates that share `lib/repo-root.mjs`, and so must agree outside a checkout. */
const SHARED_ANCHOR_GATES = [
  ["check-no-nul", "scripts/lib/check-no-nul.mjs"],
  ["verify-no-company-identifiers", "scripts/verify-no-company-identifiers.mjs"],
];

/**
 * Remove block and line comments, so prose about `git ls-files` is not read as a call.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Comment-free source of `file` plus everything it imports by relative path.
 *
 * @param {string} file repo-relative
 * @param {Set<string>} seen
 * @returns {string}
 */
function transitiveSource(file, seen = new Set()) {
  if (seen.has(file)) return "";
  seen.add(file);
  let source;
  try {
    source = fs.readFileSync(path.join(repoRoot, file), "utf8");
  } catch {
    return "";
  }
  let text = stripComments(source);
  for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const dep = path.relative(repoRoot, path.resolve(repoRoot, path.dirname(file), match[1]));
    text += transitiveSource(dep, seen);
  }
  return text;
}

/** @returns {string[]} repo-relative paths of every runnable gate that calls `git ls-files` */
function deriveLsFilesGates() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const entryPoints = new Set();
  for (const command of Object.values(pkg.scripts ?? {})) {
    for (const match of String(command).matchAll(/node\s+(scripts\/[\w./-]+\.mjs)/g)) {
      entryPoints.add(match[1]);
    }
  }
  return [...entryPoints].filter((file) => transitiveSource(file).includes('"ls-files"')).sort();
}

/**
 * @param {string} script repo-relative
 * @param {string} cwd
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function run(script, cwd) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, script)], {
    cwd,
    encoding: "utf8",
    input: "",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const gates = deriveLsFilesGates();

describe("the derivation of `git ls-files` gates", () => {
  it("finds every gate #1381 measured, by name", () => {
    expect(gates).toEqual(expect.arrayContaining(MEASURED_IN_1381));
  });

  it("does not sweep in a gate that only MENTIONS ls-files in a comment", () => {
    // Stated against a constructed sample, not against the tree. Asserted against the
    // tree it was a TAUTOLOGY, and the mutation sweep for this PR caught it: delete
    // `stripComments` and the repository still derives the same four gates, because the
    // three core modules that discuss `git ls-files` all write it in BACKTICKS, which
    // the quoted-literal match never matched in the first place. A commented-out call
    // does not have that protection, and that is the case the stripper is for.
    const commentedOutCall = [
      "/* historical: this used to run",
      '   execFileSync("git", ["ls-files", "-z"]); */',
      'const files = readdirSync(".");',
    ].join("\n");

    expect(commentedOutCall).toContain('"ls-files"');
    expect(stripComments(commentedOutCall)).not.toContain('"ls-files"');
  });

  it("still keeps `review:adversarial-tally` out of the set", () => {
    // Belt to the braces above: the tally reads stdin and scans nothing, so sweeping it
    // in would leave the comparison below green while measuring the wrong thing.
    expect(gates).not.toContain("scripts/adversarial-tally.mjs");
  });
});

describe.each(gates)("%s", (gate) => {
  it("produces identical output from the repository root and from server/src", () => {
    expect(fs.existsSync(SUBDIR)).toBe(true);

    const fromRoot = run(gate, repoRoot);
    const fromSub = run(gate, SUBDIR);

    expect(fromSub.stdout).toBe(fromRoot.stdout);
    expect(fromSub.stderr).toBe(fromRoot.stderr);
    expect(fromSub.status).toBe(fromRoot.status);
    // A gate that emits nothing at all would satisfy the three lines above without
    // having scanned anything, so require it to have said something.
    expect(`${fromRoot.stdout}${fromRoot.stderr}`.trim().length).toBeGreaterThan(0);
  });
});

describe("outside a git checkout, the two gates sharing lib/repo-root.mjs agree", () => {
  /** @returns {string} a directory with files and no repository above it */
  function makeNonRepo() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "no-git-")));
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n", "utf8");
    return dir;
  }

  it("both exit 1 with prose, and the prose differs only by the gate's own name", () => {
    // #1381's second question. Both used to throw an `execFileSync` stack trace, which
    // is what a source tarball with no `.git` got out of `pnpm lint`. "Skip and exit 0"
    // was rejected: the tracked-file set outside a repository is unknown, not empty,
    // and this gate already answers that question the same way one file at a time
    // (#1215). Sharing one implementation is what keeps the two answers the same.
    const dir = makeNonRepo();
    try {
      /** @type {Record<string, string>} */
      const normalised = {};
      for (const [name, script] of SHARED_ANCHOR_GATES) {
        const { status, stdout, stderr } = run(script, dir);
        const output = `${stdout}${stderr}`;

        expect(status, `${name} must fail outside a checkout`).toBe(1);
        expect(output).toContain(`${name}: not a git checkout — NOTHING was scanned.`);
        expect(output, `${name} must not print a stack trace`).not.toMatch(/^\s+at /m);
        normalised[name] = output.replace(`${name}:`, "GATE:");
      }

      const [first, second] = Object.values(normalised);
      expect(second).toBe(first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
