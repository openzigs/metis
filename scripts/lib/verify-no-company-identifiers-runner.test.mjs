import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Runner-level tests for `node scripts/verify-no-company-identifiers.mjs` (#1373).
 *
 * The core's unit tests exercise pure functions with an injected reader. They cannot
 * see the three things that only exist in the runner, and that are exactly where a
 * gate fails open:
 *
 *   1. the `git ls-files` enumeration (does it see the tracked file at all?),
 *   2. the exit code (a gate that prints a violation and exits 0 enforces nothing),
 *   3. the lstat/symlink/ENOENT classification.
 *
 * The scripts package's coverage config measures `lib/**` only, so top-level runners
 * report 0% however well they are covered (#1207). Spawning the real script is what
 * covers this one; the percentage is not evidence about it either way.
 *
 * Every sample term here is INVENTED and handed to the runner through
 * `METIS_PRIVATE_TERMS`. The real vocabulary is not in this repository, and this file
 * is itself scanned by the gate.
 */

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "verify-no-company-identifiers.mjs",
);

const BANNED = "zorblax";
const TERMS = `# invented\n${BANNED}\n=qzx\n`;

/** @type {string[]} */
const tempDirs = [];

/**
 * A throwaway git repo containing `files`, all tracked.
 *
 * @param {Record<string, string>} files
 * @returns {string}
 */
function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "company-id-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  return dir;
}

/**
 * Spawn the runner with a HERMETIC environment: `HOME` points at an empty directory so
 * the developer's real `~/.config/metis/private-terms.txt` cannot leak into a fixture
 * run, and the two gate variables are set only from `env`.
 *
 * @param {string} cwd
 * @param {Record<string, string>} [env] defaults to supplying the invented list
 * @returns {{ status: number | null, output: string }}
 */
function run(cwd, env = { METIS_PRIVATE_TERMS: TERMS }) {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "company-id-home-"));
  tempDirs.push(emptyHome);
  const inherited = { ...process.env };
  delete inherited.METIS_PRIVATE_TERMS;
  delete inherited.METIS_PRIVATE_TERMS_FILE;
  delete inherited.METIS_REQUIRE_PRIVATE_TERMS;
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    env: { ...inherited, HOME: emptyHome, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(/** @type {string} */ (tempDirs.pop()), { recursive: true, force: true });
  }
});

describe("verify-no-company-identifiers runner", () => {
  it("exits 0 and says what it scanned on a clean tree", () => {
    const { status, output } = run(
      makeRepo({
        "docs/a.md": "ghcr.io/openzigs/metis-server\n",
        "docker-compose.yml": "REPO_ALLOWED_HOSTS: ${REPO_ALLOWED_HOSTS:-github.com}\n",
      }),
    );

    expect(status).toBe(0);
    expect(output).toContain("2 tracked text files");
    expect(output).toContain("against 2 private terms (env METIS_PRIVATE_TERMS), none found");
  });

  it("exits 1 and names file:line for a deliberate violation", () => {
    // This is the mutation the issue asks for, run as a test rather than as a commit:
    // a tracked file carrying the identifier must take the gate red.
    const { status, output } = run(
      makeRepo({
        "docs/a.md": "clean line\n",
        "docker-compose.yml": `REPO_ALLOWED_HOSTS: github.com,git.${BANNED}.com\n`,
      }),
    );

    expect(status).toBe(1);
    expect(output).toContain("docker-compose.yml:1  term #1");
    expect(output).toContain("Private vocabulary found");
    // The log may be public: the runner must never echo what it matched.
    expect(output.toLowerCase()).not.toContain(BANNED);
  });

  it("catches the identifier in an UPPERCASE form", () => {
    const { status } = run(makeRepo({ "docs/a.md": `${BANNED.toUpperCase()}/DOT example\n` }));

    expect(status).toBe(1);
  });

  it("catches the identifier on a line other than the first", () => {
    const { status, output } = run(makeRepo({ "docs/a.md": `one\ntwo\nthree ${BANNED}\n` }));

    expect(status).toBe(1);
    expect(output).toContain("docs/a.md:3  term #1");
  });

  it("DOES fail on a violation inside a tracked eval-data path", () => {
    // #1373 excused `eval-data/` and `eval-results/` because #1308 said neither would
    // ship. #1382 shipped that decision by untracking them — and 139 `eval-data/`
    // files stayed tracked, so the excuse had to go with it. A hit in a TRACKED
    // eval path is now a defect like any other. (An untracked one is covered by the
    // next test: the gate only ever sees what git tracks.)
    const { status, output } = run(
      makeRepo({
        "eval-data/corpus/x/queries.json": `{"quote":"${BANNED} everywhere"}\n`,
        "docs/a.md": "clean\n",
      }),
    );

    expect(status).toBe(1);
    expect(output).toContain("eval-data/corpus/x/queries.json:1  term #1");
  });

  it("scans an UNTRACKED file's directory neighbours but not the untracked file itself", () => {
    // The gate's scope is what git would publish. An untracked scratch file is not in
    // the tree, and failing on one would make the gate unusable locally.
    const dir = makeRepo({ "docs/a.md": "clean\n" });
    fs.writeFileSync(path.join(dir, "scratch.md"), `${BANNED}\n`, "utf8");

    expect(run(dir).status).toBe(0);
  });

  it("scans the WHOLE repository when invoked from a subdirectory", () => {
    // `git ls-files` enumerates the current directory's subtree, not the repository.
    // Measured before the fix: run from a subdirectory, the gate reported success
    // about a tree it had never opened — the worst shape a gate can have, because the
    // success is louder than the omission. `pnpm lint` runs at the root and would
    // never have exposed it; `pnpm identifiers:verify` from anywhere else would.
    const dir = makeRepo({
      "docker-compose.yml": `host: git.${BANNED}.com\n`,
      "server/src/a.ts": "clean\n",
    });

    const { status, output } = run(path.join(dir, "server", "src"));

    expect(status).toBe(1);
    expect(output).toContain("docker-compose.yml:1  term #1");
  });

  it("does not follow a tracked symlink to a directory", () => {
    // `.claude/skills/*` are tracked symlinks to directories; following them throws
    // EISDIR on every one and would fail the gate on this repository's own tree
    // (#1215). The blob is the link text, so that is what gets scanned.
    const dir = makeRepo({ "real/a.md": "clean\n" });
    fs.symlinkSync("real", path.join(dir, "link"));
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "link"], { cwd: dir });

    const { status, output } = run(dir);

    expect(status).toBe(0);
    expect(output).not.toContain("NOT scanned");
  });

  it("fails when a tracked path is a DIRECTORY in the worktree — unknown is not clean", () => {
    const dir = makeRepo({ "docs/a.md": "clean\n" });
    fs.rmSync(path.join(dir, "docs/a.md"));
    fs.mkdirSync(path.join(dir, "docs/a.md"));

    const { status, output } = run(dir);

    expect(status).toBe(1);
    expect(output).toContain("NOT scanned");
    expect(output).toContain("docs/a.md");
  });

  it("does not fail when a tracked file is merely absent from the worktree", () => {
    const dir = makeRepo({ "docs/a.md": "clean\n", "docs/b.md": "clean\n" });
    fs.rmSync(path.join(dir, "docs/b.md"));

    const { status, output } = run(dir);

    expect(status).toBe(0);
    expect(output).toContain("1 tracked path(s) not present in this worktree");
  });
});

describe("the term list is resolved from outside the tree", () => {
  it("reads <repo>/.private-terms when the environment supplies nothing", () => {
    const dir = makeRepo({ "docs/a.md": `${BANNED}\n`, ".gitignore": ".private-terms\n" });
    fs.writeFileSync(path.join(dir, ".private-terms"), TERMS, "utf8");

    const { status, output } = run(dir, {});

    expect(status).toBe(1);
    expect(output).toContain("docs/a.md:1  term #1");
  });

  it("reads ~/.config/metis/private-terms.txt as the last resort", () => {
    const dir = makeRepo({ "docs/a.md": `${BANNED}\n` });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "company-id-home-"));
    tempDirs.push(home);
    fs.mkdirSync(path.join(home, ".config", "metis"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "metis", "private-terms.txt"), TERMS, "utf8");

    expect(run(dir, { HOME: home }).status).toBe(1);
  });

  it("SKIPS loudly — never 'none found' — when no list is configured", () => {
    // An outside contributor cannot hold the list and must still be able to lint. What
    // the gate may not do is describe an unchecked tree as a clean one.
    const { status, output } = run(makeRepo({ "docs/a.md": `${BANNED}\n` }), {});

    expect(status).toBe(0);
    expect(output).toContain("SKIPPED");
    expect(output).toContain("nothing was checked");
    expect(output).not.toContain("none found");
  });

  it("FAILS when the list is required and absent — a disarmed gate is not a pass", () => {
    const { status, output } = run(makeRepo({ "docs/a.md": "clean\n" }), {
      METIS_REQUIRE_PRIVATE_TERMS: "1",
    });

    expect(status).toBe(1);
    expect(output).toContain("NOTHING WAS CHECKED");
  });

  it("treats an EMPTY secret as absent: Actions passes an unset secret as ''", () => {
    const { status } = run(makeRepo({ "docs/a.md": "clean\n" }), {
      METIS_PRIVATE_TERMS: "",
      METIS_REQUIRE_PRIVATE_TERMS: "true",
    });

    expect(status).toBe(1);
  });

  it("FAILS on a list that parses to zero terms rather than reporting a clean scan", () => {
    const { status, output } = run(makeRepo({ "docs/a.md": `${BANNED}\n` }), {
      METIS_PRIVATE_TERMS: "# only a comment\n",
    });

    expect(status).toBe(1);
    expect(output).toContain("EMPTY");
  });

  it("flags a term that appears only in a tracked PATH", () => {
    const { status, output } = run(makeRepo({ "src/qzx/load.ts": "clean\n" }));

    expect(status).toBe(1);
    expect(output).toContain("(in the PATH)  term #2");
  });
});

describe("this repository's own tree", () => {
  it("passes the gate with whatever list this environment has", () => {
    // With the maintainers' list present (their machines, the main repository's CI)
    // this is the real acceptance test: a reintroduced term fails `pnpm test` as well
    // as `pnpm lint`. Without it the runner skips and this proves only that the tree
    // does not trip the invented list — which is why ci.yml sets
    // METIS_REQUIRE_PRIVATE_TERMS on the lint step rather than relying on this test.
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: "utf8" });

    expect(`${result.stdout}${result.stderr}`).not.toContain("Private vocabulary found");
    expect(result.status).toBe(0);
  });
});
