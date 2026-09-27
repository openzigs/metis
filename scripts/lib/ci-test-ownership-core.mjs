/**
 * Which CI job runs which workspace package's unit suite (#4).
 *
 * ## The failure this exists to catch
 *
 * The `api` job ran the ROOT `pnpm test`, which fans out to every workspace package,
 * while the `ui` job ran the ui suite again and `postgres-adapter` ran the server
 * suite again. 86% of `api`'s wall clock was a suite other jobs already ran. The
 * obvious fix — narrow `api`'s test step — has two quiet ways to go wrong:
 *
 *   1. A package stops being tested by ANY job. Nothing reports a suite that never
 *      ran; the check column stays green.
 *   2. A package is dropped from one job on the belief that another job "covers" it,
 *      when that other job runs it under a different configuration. Measured on #4:
 *      `postgres-adapter` runs the server suite against the Postgres-generated Prisma
 *      client, where 14 files (288 tests) SKIP themselves — every `*.sqlite.test.ts`
 *      among them. It is not a substitute for the SQLite run.
 *
 * So this module reads the workflow text and answers, per package: which jobs run its
 * full unit suite? The repository test (`ci-test-ownership-repo.test.mjs`) then
 * requires exactly one DEFAULT-configuration owner per package, and names the jobs
 * that deliberately re-run a suite under another configuration.
 *
 * ## The pnpm trap it models
 *
 * `pnpm -r --filter '!x' run test` typed at the repository root SELECTS THE ROOT
 * PACKAGE TOO (only-negative filters start from "everything"), and the root's own
 * `test` script is `pnpm -r ... run test` — so a narrowed command without
 * `--filter '!metis'` silently re-runs the whole monorepo. That was measured while
 * writing #4. {@link resolvePnpmTest} expands the root script exactly as pnpm does.
 *
 * Pure: no filesystem access. The caller passes the workflow text and the packages.
 */

/**
 * @typedef {{ name: string, dir: string, hasTest: boolean, testScript?: string }} WorkspacePackage
 * @typedef {{ job: string, step: string, dir: string, command: string }} TestInvocation
 */

/**
 * Split a workflow into its top-level jobs: `  <name>:` under `jobs:` up to the next
 * such key.
 *
 * @param {string} workflow
 * @returns {Map<string, string[]>} job name -> its lines (excluding the header)
 */
export function splitJobs(workflow) {
  const lines = workflow.split(/\r?\n/);
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  /** @type {Map<string, string[]>} */
  const jobs = new Map();
  if (jobsAt < 0) return jobs;
  /** @type {string[] | null} */
  let current = null;
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level key
    const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      current = [];
      jobs.set(header[1], current);
      continue;
    }
    if (current) current.push(line);
  }
  return jobs;
}

/**
 * Every `pnpm` command a job's steps run, with the directory it runs in.
 *
 * Understands `run:` inline and as a block scalar (`|`, `>-`, ...), a step's
 * `working-directory:`, and a job-level `defaults.run.working-directory`. Commands
 * inside a block are split on newlines and on `&&`.
 *
 * @param {string} job
 * @param {string[]} jobLines
 * @returns {TestInvocation[]}
 */
export function extractPnpmCommands(job, jobLines) {
  let defaultDir = ".";
  const defaultsAt = jobLines.findIndex((l) => /^ {4}defaults:\s*$/.test(l));
  if (defaultsAt >= 0) {
    for (let i = defaultsAt + 1; i < jobLines.length && /^ {5,}/.test(jobLines[i]); i += 1) {
      const m = jobLines[i].match(/^\s+working-directory:\s*(\S+)\s*$/);
      if (m) defaultDir = m[1];
    }
  }

  /** @type {string[][]} */
  const steps = [];
  for (const line of jobLines) {
    if (/^ {6}- /.test(line)) steps.push([line.replace(/^ {6}- /, "        ")]);
    else if (steps.length > 0 && (/^ {8}/.test(line) || line.trim() === "")) {
      steps[steps.length - 1].push(line);
    }
  }

  /** @type {TestInvocation[]} */
  const out = [];
  for (const step of steps) {
    let name = "";
    let dir = defaultDir;
    /** @type {string[]} */
    const runLines = [];
    for (let i = 0; i < step.length; i += 1) {
      const line = step[i];
      const nameM = line.match(/^ {8}name:\s*(.+?)\s*$/);
      if (nameM) name = nameM[1];
      const dirM = line.match(/^ {8}working-directory:\s*(\S+)\s*$/);
      if (dirM) dir = dirM[1];
      const runM = line.match(/^ {8}run:\s*(.*)$/);
      if (!runM) continue;
      const inline = runM[1].trim();
      if (inline && !/^[|>][-+]?$/.test(inline)) {
        runLines.push(inline);
        continue;
      }
      for (
        let j = i + 1;
        j < step.length && (/^ {10}/.test(step[j]) || step[j].trim() === "");
        j += 1
      ) {
        runLines.push(step[j].trim());
      }
    }
    for (const cmd of runLines.flatMap((l) => l.split("&&")).map((c) => c.trim())) {
      if (/^pnpm\s/.test(cmd)) out.push({ job, step: name, dir, command: cmd });
    }
  }
  return out;
}

/**
 * Split a shell word list, honouring single and double quotes (no expansion — the
 * commands under audit carry no variables in the parts that matter).
 *
 * @param {string} command
 * @returns {string[]}
 */
export function shellWords(command) {
  /** @type {string[]} */
  const words = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

/**
 * The packages whose FULL unit suite a `pnpm` command runs, or `[]` when it runs no
 * full suite (`pnpm exec vitest run <files>`, `pnpm test:integration ...`, installs,
 * builds, lint).
 *
 * @param {string} command
 * @param {string} dir working directory, relative to the repository root ("." = root)
 * @param {WorkspacePackage[]} packages every workspace package, the root included (dir ".")
 * @param {number} [depth] recursion guard for the root script's expansion
 * @returns {string[]} package names, sorted
 */
export function resolvePnpmTest(command, dir, packages, depth = 0) {
  if (depth > 4) throw new Error(`test script recursion too deep at: ${command}`);
  const words = shellWords(command);
  if (words[0] !== "pnpm") return [];
  let recursive = false;
  /** @type {string[]} */
  const filters = [];
  /** @type {string[]} */
  const rest = [];
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i];
    if (w === "-r" || w === "--recursive") recursive = true;
    else if (w === "--filter" || w === "-F") {
      filters.push(words[i + 1] ?? "");
      i += 1;
    } else if (w.startsWith("--filter=")) filters.push(w.slice("--filter=".length));
    else rest.push(w);
  }
  const script = rest[0] === "run" ? rest[1] : rest[0];
  if (script !== "test") return [];

  /** @type {WorkspacePackage[]} */
  let selected;
  if (filters.length === 0 && !recursive) {
    const here = packages.find((p) => p.dir === dir);
    if (!here) throw new Error(`no workspace package at ${dir} (command: ${command})`);
    selected = [here];
  } else {
    const positive = filters.filter((f) => !f.startsWith("!"));
    const negative = filters.filter((f) => f.startsWith("!")).map((f) => f.slice(1));
    // pnpm: only-negative filters (or bare -r) start from EVERY package, the root
    // included when typed at the root.
    selected =
      positive.length === 0
        ? [...packages]
        : packages.filter((p) => positive.some((f) => matches(p, f)));
    selected = selected.filter((p) => !negative.some((f) => matches(p, f)));
  }

  /** @type {Set<string>} */
  const names = new Set();
  for (const p of selected) {
    if (!p.hasTest) continue;
    if (p.dir === "." && p.testScript) {
      // The root's `test` is itself a recursive pnpm command: expand it the way pnpm
      // runs it (from the root, excluding the root, which pnpm does not re-enter).
      const nested = resolvePnpmTest(
        p.testScript,
        ".",
        packages.filter((q) => q.dir !== "."),
        depth + 1,
      );
      for (const n of nested) names.add(n);
      continue;
    }
    names.add(p.name);
  }
  return [...names].sort();
}

/**
 * @param {WorkspacePackage} p
 * @param {string} filter
 */
function matches(p, filter) {
  if (filter.startsWith("./")) return p.dir === filter.slice(2).replace(/\/$/, "");
  return p.name === filter;
}

/**
 * Package name -> the jobs that run its full unit suite.
 *
 * @param {string} workflow
 * @param {WorkspacePackage[]} packages
 * @returns {Map<string, string[]>} every package with a test script appears, possibly with `[]`
 */
export function testOwnership(workflow, packages) {
  /** @type {Map<string, string[]>} */
  const owners = new Map(
    packages.filter((p) => p.hasTest && p.dir !== ".").map((p) => [p.name, []]),
  );
  for (const [job, lines] of splitJobs(workflow)) {
    for (const inv of extractPnpmCommands(job, lines)) {
      for (const name of resolvePnpmTest(inv.command, inv.dir, packages)) {
        const list = owners.get(name);
        if (list && !list.includes(job)) list.push(job);
      }
    }
  }
  return owners;
}

/**
 * Audit ownership: every package must have exactly one owner among the jobs NOT in
 * `variantJobs` (jobs that re-run a suite under a different configuration on
 * purpose), and every variant job must still run what it is declared to run.
 *
 * @param {Map<string, string[]>} owners from {@link testOwnership}
 * @param {Readonly<Record<string, ReadonlyArray<string>>>} variantJobs job -> packages it re-runs
 * @param {ReadonlyArray<string>} [exempt] packages that are deliberately not unit-tested in CI
 * @returns {string[]} human-readable problems; empty when the invariant holds
 */
export function auditOwnership(owners, variantJobs, exempt = []) {
  /** @type {string[]} */
  const problems = [];
  for (const [pkg, jobs] of owners) {
    if (exempt.includes(pkg)) continue;
    const primary = jobs.filter((j) => !(j in variantJobs));
    if (primary.length === 0) problems.push(`${pkg}: no job runs its unit suite`);
    else if (primary.length > 1)
      problems.push(`${pkg}: unit suite runs in ${primary.length} jobs (${primary.join(", ")})`);
  }
  for (const [job, pkgs] of Object.entries(variantJobs)) {
    for (const pkg of pkgs) {
      if (!(owners.get(pkg) ?? []).includes(job)) {
        problems.push(
          `${job}: declared to re-run ${pkg} under its own configuration, but does not`,
        );
      }
    }
  }
  return problems;
}
