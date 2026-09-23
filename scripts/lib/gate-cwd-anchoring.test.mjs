import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
 *
 * ## Over a small index, not the whole tree (#97, #99)
 *
 * The comparison used to run every gate twice over all ~4,100 tracked files. The
 * private-vocabulary gate alone took 1.9 s per spawn on an idle machine, so its arm was
 * ~3.9 s of CPU against vitest's 5 s default — and 16.4 s when `pnpm test` ran the other
 * 57 files beside it. The margin shrank with every file added to the repository.
 *
 * What this test measures is ANCHORING, and anchoring is a property of how a gate finds
 * the repository, not of how many files the repository holds. So each spawn is handed a
 * throwaway git index (`GIT_INDEX_FILE`) holding a small, fixed-shape subset of the real
 * tracked paths: root-level files, `.claude/`, `.github/`, every `package.json`, and a
 * few files under `server/src`. The gates still run from their real location over the
 * real files on disk — only what `git ls-files` enumerates shrinks. The subset has files
 * on BOTH sides of `server/src`, which is what makes an un-anchored gate's output differ
 * (a pinned test below requires both sides; deleting the `chdir` in `lib/repo-root.mjs`
 * turns three arms red), and its size tracks those config directories,
 * not the tree: measured at 144 of 4,104 paths, every gate under 0.45 s per spawn.
 *
 * The one arm that must scan the WHOLE tree — the acceptance check that this repository
 * carries no private term — lives in `verify-no-company-identifiers-runner.test.mjs` and
 * runs once, in the package's global setup, outside the timed and parallel pool.
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

/** How many tracked files under `server/src` the subset index keeps. */
const SUBDIR_SAMPLE = 3;

/**
 * Whether a tracked path belongs in the subset index. Chosen so every derived gate has
 * something real to answer about: the agent and skill gates read `.claude/` and
 * `.github/`, the licence gate every `package.json`, and the tree scanners get root-level
 * files outside `server/src` to discriminate an anchored scan from an un-anchored one.
 *
 * @param {string} file repo-relative
 * @returns {boolean}
 */
function inSubset(file) {
  return (
    !file.includes("/") ||
    file.startsWith(".claude/") ||
    file.startsWith(".github/") ||
    path.posix.basename(file) === "package.json"
  );
}

/**
 * Write a git index holding the subset (plus the first few `server/src` files) to `indexFile`.
 *
 * @param {string} indexFile absolute path; must not exist yet
 * @returns {string[]} the paths it holds
 */
function writeSubsetIndex(indexFile) {
  const entries = execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((entry) => entry.length > 0);
  const pathOf = (/** @type {string} */ entry) => entry.slice(entry.indexOf("\t") + 1);
  const kept = [
    ...entries.filter((entry) => inSubset(pathOf(entry))),
    ...entries.filter((entry) => pathOf(entry).startsWith("server/src/")).slice(0, SUBDIR_SAMPLE),
  ];
  execFileSync("git", ["update-index", "-z", "--index-info"], {
    cwd: repoRoot,
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
    input: kept.map((entry) => `${entry}\0`).join(""),
  });
  return kept.map(pathOf);
}

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
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function run(script, cwd, env = process.env) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, script)], {
    cwd,
    encoding: "utf8",
    input: "",
    env,
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

describe("over a subset index", () => {
  /** @type {string} */
  let scratch;
  /** @type {string[]} */
  let subset;
  /** @type {NodeJS.ProcessEnv} */
  let env;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gate-anchor-index-"));
    const indexFile = path.join(scratch, "index");
    subset = writeSubsetIndex(indexFile);
    // An invented term no file can contain, supplied inline: the vocabulary gate must
    // SCAN here rather than skip, whatever list this machine does or does not hold. A
    // skip happens after the anchor but before enumeration, so a skipped gate would be
    // identical from both directories even with its anchor deleted.
    const inherited = { ...process.env };
    delete inherited.METIS_PRIVATE_TERMS_FILE;
    delete inherited.METIS_REQUIRE_PRIVATE_TERMS;
    env = {
      ...inherited,
      GIT_INDEX_FILE: indexFile,
      METIS_PRIVATE_TERMS: `anchor${randomBytes(12).toString("hex")}`,
    };
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("holds files on both sides of server/src, and a small fraction of the tree", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
      .split("\0")
      .filter((file) => file.length > 0);

    // Inside server/src, so the subdirectory run has a real subtree to enumerate; outside
    // it, so an un-anchored run enumerates a DIFFERENT set from the root run.
    expect(subset.filter((file) => file.startsWith("server/src/")).length).toBeGreaterThan(0);
    expect(subset.filter((file) => !file.startsWith("server/src/")).length).toBeGreaterThan(0);
    // The point of the index: the workload no longer grows with the repository.
    expect(subset.length).toBeLessThan(tracked.length / 4);
  });

  it("is what the gates actually enumerate — the injection is not silently ignored", () => {
    // Without this pin, a gate that stopped honouring GIT_INDEX_FILE would quietly go
    // back to scanning the whole tree, and the only symptom would be the timeout this
    // file was changed to remove.
    const { stdout } = run("scripts/verify-no-company-identifiers.mjs", repoRoot, env);

    expect(stdout).toContain(`and ${subset.length} paths scanned`);
  });

  describe.each(gates)("%s", (gate) => {
    it("produces identical output from the repository root and from server/src", () => {
      expect(fs.existsSync(SUBDIR)).toBe(true);

      const fromRoot = run(gate, repoRoot, env);
      const fromSub = run(gate, SUBDIR, env);

      expect(fromSub.stdout).toBe(fromRoot.stdout);
      expect(fromSub.stderr).toBe(fromRoot.stderr);
      expect(fromSub.status).toBe(fromRoot.status);
      // A gate that emits nothing at all would satisfy the three lines above without
      // having scanned anything, so require it to have said something.
      expect(`${fromRoot.stdout}${fromRoot.stderr}`.trim().length).toBeGreaterThan(0);
    });
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
