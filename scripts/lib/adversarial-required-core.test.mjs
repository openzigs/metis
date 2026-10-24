/**
 * `pnpm review:adversarial-required` must fail closed (#1476 review). The SKILL.md one-liner it
 * replaced printed `{ required: false }` with exit 0 for an unknown ref, an empty stdin and a
 * forced-colour diff. These tests run real git in throwaway repositories, with global and system
 * config cut off so a developer's own git config cannot change the result.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AdversarialRequiredError,
  DIFF_FORMAT_FLAGS,
  computeAdversarialRequirement,
  execGit,
} from "./adversarial-required-core.mjs";

const CLI = fileURLToPath(new URL("../adversarial-required.mjs", import.meta.url));
const PRODUCTION_DEPS = "server/src/lib/agents/pr-reviewer/production-deps.ts";

/** #1474's production-deps.ts, rebuilt from the recorded new-file diff. */
const productionDepsSource = readFileSync(
  fileURLToPath(new URL("./fixtures/1474-production-deps.diff", import.meta.url)),
  "utf8",
)
  .split("\n")
  .slice(6) // header + `@@` line of a new-file diff
  .filter((l) => l.startsWith("+"))
  .map((l) => l.slice(1))
  .join("\n");

/** @type {string[]} */
const scratch = [];
/** @type {Record<string, string | undefined>} */
const savedEnv = {};
const ISOLATING_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "adv-required-home-"));
  scratch.push(home);
  const globalConfig = join(home, "gitconfig");
  writeFileSync(globalConfig, "");
  for (const [k, v] of Object.entries({ ...ISOLATING_ENV, GIT_CONFIG_GLOBAL: globalConfig })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * @param {string} cwd
 * @param {...string} args
 */
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A repo with one commit on `main`, then `files` committed on top of it on `feature`.
 *
 * @param {Record<string, string>} files
 * @returns {string}
 */
function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "adv-required-"));
  scratch.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "branch", "-M", "main");
  git(dir, "checkout", "-q", "-b", "feature");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "change");
  return dir;
}

describe("computeAdversarialRequirement (#1476)", () => {
  it("requires a panel for #1474's production-deps.ts, from the import arm alone", () => {
    const dir = repoWith({ [PRODUCTION_DEPS]: productionDepsSource });
    const result = computeAdversarialRequirement({ git: execGit(dir), base: "main" });
    expect(result.changedPaths).toEqual([PRODUCTION_DEPS]);
    expect(result.required).toBe(true);
    expect(result.reasons.map((r) => r.match(/\(([^:]+):/)?.[1])).toEqual([
      "vault-resolver",
      "octokit-factory",
      "host-allowlist",
      "vault/",
    ]);
  });

  it("does not require a panel for an unrelated change", () => {
    const dir = repoWith({ "ui/src/spinner.tsx": 'import { cn } from "@/lib/utils";\n' });
    const result = computeAdversarialRequirement({ git: execGit(dir), base: "main" });
    expect(result).toMatchObject({ required: false, reasons: [], addedImports: ["@/lib/utils"] });
  });

  it.each([
    ["color.diff=always", ["color.diff", "always"]],
    ["color.ui=always", ["color.ui", "always"]],
    ["diff.noprefix=true", ["diff.noprefix", "true"]],
    ["diff.mnemonicPrefix=true", ["diff.mnemonicPrefix", "true"]],
    ["diff.external=false", ["diff.external", "false"]],
    ["diff.relative=true", ["diff.relative", "true"]],
  ])("still parses the diff under %s", (_label, [key, value]) => {
    const dir = repoWith({ [PRODUCTION_DEPS]: productionDepsSource });
    git(dir, "config", key, value);
    const result = computeAdversarialRequirement({ git: execGit(dir), base: "main" });
    expect(result.required).toBe(true);
    expect(result.addedImports).toContain("../../vault/vault-service.js");
  });

  it("still sees the whole change when run from a subdirectory under diff.relative=true", () => {
    const dir = repoWith({ [PRODUCTION_DEPS]: productionDepsSource, "ui/x.ts": "" });
    git(dir, "config", "diff.relative", "true");
    const result = computeAdversarialRequirement({ git: execGit(join(dir, "ui")), base: "main" });
    expect(result.changedPaths.sort()).toEqual([PRODUCTION_DEPS, "ui/x.ts"]);
    expect(result.required).toBe(true);
  });

  it("THROWS when the base names a blob rather than a commit", () => {
    const dir = repoWith({ "a.ts": "" });
    const blob = git(dir, "rev-parse", "main:README.md").trim();
    expect(() => computeAdversarialRequirement({ git: execGit(dir), base: blob })).toThrow(
      /does not resolve to a commit/,
    );
  });

  it("reads a CRLF file's imports", () => {
    const dir = repoWith({
      "server/src/w.ts": 'import { x } from "../vault/v.js";\r\nexport {};\r\n',
    });
    const result = computeAdversarialRequirement({ git: execGit(dir), base: "main" });
    expect(result.addedImports).toEqual(["../vault/v.js"]);
  });

  it("reads a path git quotes (a space and non-ASCII)", () => {
    const path = "server/src/my café/deps.ts";
    const dir = repoWith({ [path]: 'import { x } from "../vault/vault-service.js";\n' });
    const result = computeAdversarialRequirement({ git: execGit(dir), base: "main" });
    expect(result.changedPaths).toEqual([path]);
    expect(result.required).toBe(true);
  });

  it("reads binary and deleted files without losing their paths", () => {
    const dir = repoWith({ "assets/logo.bin": "\u0000\u0001binary" });
    git(dir, "rm", "-q", "README.md");
    git(dir, "commit", "-q", "-m", "delete");
    const result = computeAdversarialRequirement({ git: execGit(dir), base: "main" });
    expect(result.changedPaths.sort()).toEqual(["README.md", "assets/logo.bin"]);
  });

  it("THROWS on an unknown base ref instead of answering not-required", () => {
    const dir = repoWith({ "a.ts": "" });
    expect(() =>
      computeAdversarialRequirement({ git: execGit(dir), base: "origin/no-such-branch" }),
    ).toThrow(/base ref `origin\/no-such-branch` does not resolve to a commit/);
  });

  it("THROWS on an unknown head ref", () => {
    const dir = repoWith({ "a.ts": "" });
    expect(() =>
      computeAdversarialRequirement({ git: execGit(dir), base: "main", head: "nope" }),
    ).toThrow(/head ref `nope`/);
  });

  it("THROWS when there is no merge base (unrelated history, as in a shallow clone)", () => {
    const dir = repoWith({ "a.ts": "" });
    git(dir, "checkout", "-q", "--orphan", "island");
    git(dir, "commit", "-q", "-m", "island");
    expect(() =>
      computeAdversarialRequirement({ git: execGit(dir), base: "main", head: "island" }),
    ).toThrow(/no merge base/);
  });

  /** A runner that answers rev-parse and merge-base, and returns `names`/`diff` for the two diffs. */
  const fakeGit =
    (/** @type {string} */ names, /** @type {string} */ diff) => (/** @type {string[]} */ args) => {
      if (args[0] === "rev-parse") return "a".repeat(40);
      if (args[0] === "merge-base") return "b".repeat(40);
      return args.includes("--name-only") ? names : diff;
    };

  it("THROWS when paths changed but the diff came back empty", () => {
    expect(() =>
      computeAdversarialRequirement({ git: fakeGit(`${PRODUCTION_DEPS}\0`, "") }),
    ).toThrow(/1 path\(s\) changed .* but the diff came back empty/);
  });

  it("THROWS when the diff text cannot be read for a changed path", () => {
    const coloured = `\u001b[1mdiff --git a/${PRODUCTION_DEPS} b/${PRODUCTION_DEPS}\u001b[m\n`;
    expect(() =>
      computeAdversarialRequirement({ git: fakeGit(`${PRODUCTION_DEPS}\0`, coloured) }),
    ).toThrow(/could not be parsed for 1 of 1/);
  });

  it("answers not-required for a branch with no changes", () => {
    expect(computeAdversarialRequirement({ git: fakeGit("", "") })).toMatchObject({
      required: false,
      changedPaths: [],
    });
  });

  it("wraps a git failure with git's own stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "adv-required-nogit-"));
    scratch.push(dir);
    expect(() => execGit(dir)(["log"])).toThrow(AdversarialRequiredError);
    expect(() => execGit(dir)(["log"])).toThrow(/`git log` failed: .*not a git repository/i);
  });

  it("pins every diff option that config can override", () => {
    expect(DIFF_FORMAT_FLAGS).toEqual(
      expect.arrayContaining(["--no-color", "--no-ext-diff", "--src-prefix=a/", "--no-renames"]),
    );
  });
});

describe("pnpm review:adversarial-required (the CLI)", () => {
  /**
   * @param {string} cwd
   * @param {...string} args
   */
  const run = (cwd, ...args) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: process.env });

  it("prints required:true and exits 0 for #1474's file", () => {
    const dir = repoWith({ [PRODUCTION_DEPS]: productionDepsSource });
    const r = run(dir, "--base", "main", "--title", "feat: wire it");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ required: true, changedPaths: 1 });
  });

  it("exits 2 with a message, and prints no verdict, on an unknown ref", () => {
    const dir = repoWith({ "a.ts": "" });
    const r = run(dir, "--base", "origin/no-such-branch");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/adversarial-required: base ref `origin\/no-such-branch`/);
  });

  it("exits 2 on an unknown option", () => {
    const r = run(tmpdir(), "--bsae", "main");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/adversarial-required: /);
  });

  it("passes --label through to the label arm", () => {
    const dir = repoWith({ "docs/x.md": "x\n" });
    const r = run(dir, "--base", "main", "--label", "area: auth");
    expect(JSON.parse(r.stdout).reasons).toEqual(["label `area: auth` — declared security work"]);
  });

  it("prints usage for --help", () => {
    const r = run(tmpdir(), "--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: pnpm review:adversarial-required/);
  });
});
