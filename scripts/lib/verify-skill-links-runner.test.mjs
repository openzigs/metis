import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Integration test for the decisions `verify-skill-links.mjs` makes on its own (#1282).
 *
 * ## Why this exists
 *
 * It did not, and an adversarial panel on #1282 measured the consequence: **no test in the
 * repository ever executed this script.** `package.json`'s `skills:verify` was its only
 * caller. So while every rule inside `skill-links-core.mjs` was pinned by 35 killed
 * mutants, the glue that *feeds those rules their ground truth* was pinned by nothing —
 * deleting the whole `mcpServerNames: readMcpServerNames(), agentSlugs: readAgentSlugs()`
 * wiring left `vitest run` green, and so did four separate fail-open mutations inside
 * those two functions.
 *
 * That is the shape this repository keeps shipping. #1168's rule B asked `fs.existsSync`
 * where it should have asked git, and no test over the pure core could see it because the
 * core takes the probe's *answer* as input. #1180's `skillFiles` default was the same
 * defect one layer out. #1215 found eight more. A unit test cannot catch a runner that
 * never gathers, by construction — only running the runner can.
 *
 * So the real script runs against a throwaway repository, and every arm changes only what
 * the runner must *read*: `.mcp.json`, the two agent directories. The skill body is
 * byte-identical in every arm, which is what makes each result attributable to the glue.
 */

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** @type {string} */
let repo;

const SKILL = "probe-links";
const SKILL_MD = `.github/skills/${SKILL}/SKILL.md`;
const DESCRIPTION =
  "Use when the runner's ability to enumerate MCP servers and agent files needs measuring.";

/** @param {string} relativePath @param {string} contents */
function put(relativePath, contents) {
  const target = path.join(repo, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

/** @param {string} relativePath */
function abs(relativePath) {
  return path.join(repo, ...relativePath.split("/"));
}

/**
 * The skill body, identical in every arm. It names one MCP server and one agent file; what
 * changes between arms is only whether the runner can see that they exist.
 *
 * @param {boolean} guarded
 */
function writeSkill(guarded) {
  put(
    SKILL_MD,
    [
      "---",
      `name: ${SKILL}`,
      `description: ${DESCRIPTION}`,
      ...(guarded ? ["disable-model-invocation: true"] : []),
      "---",
      "",
      "Execute with the **Probe** agent (`probe-agent.agent.md`) using `mcp__probesrv__*`.",
    ].join("\n"),
  );
}

/** @returns {{ status: number, output: string }} */
function run() {
  const result = spawnSync(
    process.execPath,
    [path.join(repo, "scripts", "verify-skill-links.mjs")],
    {
      cwd: repo,
      encoding: "utf8",
    },
  );
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Everything the runner reads, in the state every arm starts from. */
function baseline() {
  writeSkill(false);
  put(".mcp.json", JSON.stringify({ mcpServers: { probesrv: { command: "true" } } }, null, 2));
  put(".github/agents/probe-agent.agent.md", "---\nname: Probe\n---\n\nBody.\n");
  fs.rmSync(abs(".claude/agents"), { recursive: true, force: true });
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "skills-verify-runner-"));
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(scriptsDir, "verify-skill-links.mjs"),
    path.join(repo, "scripts", "verify-skill-links.mjs"),
  );
  fs.cpSync(path.join(scriptsDir, "lib"), path.join(repo, "scripts", "lib"), { recursive: true });

  baseline();
  execFileSync("git", ["init", "--quiet"], { cwd: repo, stdio: "pipe" });
  // The link must be a committed symlink or `classifyEntry` fails for an unrelated reason.
  fs.mkdirSync(abs(".claude/skills"), { recursive: true });
  fs.symlinkSync(`../../.github/skills/${SKILL}`, abs(`.claude/skills/${SKILL}`));
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe("verify-skill-links runner: it gathers what the guard rule judges (Issue #1282)", () => {
  it("PASSES when both the server and the agent file exist", () => {
    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain("All skills are committed as symlinks");
  });

  it("FAILS when the MCP server leaves .mcp.json — the skill body is untouched", () => {
    const before = fs.readFileSync(abs(SKILL_MD), "utf8");
    put(".mcp.json", JSON.stringify({ mcpServers: { other: { command: "true" } } }, null, 2));
    expect(fs.readFileSync(abs(SKILL_MD), "utf8")).toBe(before);

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("probesrv not defined in .mcp.json");

    baseline();
    expect(run().status).toBe(0);
  });

  it("FAILS when the agent file is deleted — identity, not content", () => {
    fs.rmSync(abs(".github/agents/probe-agent.agent.md"));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("probe-agent.agent.md do not exist");

    baseline();
    expect(run().status).toBe(0);
  });

  it("consults BOTH agent surfaces, so a Claude-only twin satisfies the reference", () => {
    // Pins the union in `readAgentSlugs`. Dropping either directory from it survived the
    // unit suite, because no unit test can see which directories the runner reads.
    fs.rmSync(abs(".github/agents/probe-agent.agent.md"));
    put(".claude/agents/probe-agent.md", "---\nname: probe-agent\n---\n\nBody.\n");

    expect(run().status).toBe(0);

    baseline();
    expect(run().status).toBe(0);
  });

  it("PASSES unreachable tooling once the skill carries the guard", () => {
    fs.rmSync(abs(".github/agents/probe-agent.agent.md"));
    fs.rmSync(abs(".mcp.json"));
    writeSkill(true);

    const { status } = run();
    expect(status).toBe(0);

    baseline();
    expect(run().status).toBe(0);
  });

  it("FAILS CLOSED on a MALFORMED .mcp.json rather than reading it as no servers", () => {
    // The distinction the docstring promises: absent is a knowable answer, unparseable is
    // not. Mutating this branch to `[]` survived the unit suite AND left the real gate
    // exiting 0 (#1282, found by the panel).
    put(".mcp.json", "{ not json");

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("could not be read");

    baseline();
    expect(run().status).toBe(0);
  });

  it("PASSES with .mcp.json ABSENT and the guard in place — absent is knowable", () => {
    fs.rmSync(abs(".mcp.json"));
    fs.rmSync(abs(".github/agents/probe-agent.agent.md"));
    writeSkill(true);

    expect(run().status).toBe(0);

    baseline();
    expect(run().status).toBe(0);
  });

  it("FAILS CLOSED when NEITHER agent directory can be enumerated", () => {
    // `read === 0 ? null` — the state where the runner cannot answer "does this agent
    // exist", as distinct from answering "no". Both directories are made unreadable
    // (ENOTDIR, not ENOENT), because ENOENT IS a knowable answer and must stay one.
    // Deleting the null arm survived every other test (#1282 deletability sweep).
    fs.rmSync(abs(".github/agents"), { recursive: true, force: true });
    fs.writeFileSync(abs(".github/agents"), "not a directory", "utf8");
    fs.writeFileSync(abs(".claude/agents"), "not a directory", "utf8");

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("could not be read, so their existence cannot be decided");

    fs.rmSync(abs(".github/agents"));
    fs.rmSync(abs(".claude/agents"));
    baseline();
    expect(run().status).toBe(0);
  });

  it("PASSES when both agent directories are merely ABSENT and the skill is guarded", () => {
    // The other side of the same line: absent is knowable, so it must not fail closed.
    fs.rmSync(abs(".github/agents"), { recursive: true, force: true });
    fs.rmSync(abs(".mcp.json"));
    writeSkill(true);

    expect(run().status).toBe(0);

    baseline();
    expect(run().status).toBe(0);
  });

  it("FAILS CLOSED when .mcp.json is present but UNREADABLE (a directory — EISDIR)", () => {
    fs.rmSync(abs(".mcp.json"));
    fs.mkdirSync(abs(".mcp.json"));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("could not be read");

    fs.rmSync(abs(".mcp.json"), { recursive: true });
    baseline();
    expect(run().status).toBe(0);
  });
});
