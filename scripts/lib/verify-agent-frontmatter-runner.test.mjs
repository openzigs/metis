import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MEMORY_ENTRY_MAX_BYTES, MEMORY_INDEX_BUDGET_BYTES } from "./agent-frontmatter-core.mjs";

/**
 * Integration test for the ONE decision `verify-agent-frontmatter.mjs` makes on its
 * own: whether a project-scope memory index is **tracked in git** (Issue #1168).
 *
 * ## Why this cannot be a unit test
 *
 * Everything else in the runner is glue over the pure core, which
 * `agent-frontmatter-core.test.mjs` covers. The probe is different: rule B's whole
 * correctness is *which question it asks*. #1163 asked `fs.existsSync`, which an
 * untracked `MEMORY.md` satisfies, so the rule passed on exactly the state it
 * exists to reject. No test over the core can catch that, because the core takes
 * the probe's answer as input — and in this repository the two probes agree
 * (`code-issue` is the only `memory:` declarer and its index is committed), so the
 * gate stays green either way. Reverting the probe to `fs.existsSync` therefore
 * broke nothing that anyone could see, which is precisely how the defect shipped.
 *
 * So the runner is executed for real, in a throwaway git repository, against an
 * index that **exists on disk in both arms** and differs only in whether git is
 * tracking it. Anything that stops asking git fails this test.
 */

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Can this platform create a symlink without elevation?
 *
 * Measured rather than inferred from `process.platform`: unprivileged symlink
 * creation on Windows depends on Developer Mode, not on the OS. The arms that
 * need one skip rather than fail, and every other arm in the section runs
 * everywhere — so a Windows runner still covers the non-`.md` and subdirectory
 * halves of the same defect.
 */
const SYMLINKS_SUPPORTED = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "agents-verify-symlink-"));
  try {
    fs.writeFileSync(path.join(probe, "target"), "x", "utf8");
    fs.symlinkSync("target", path.join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

/** @type {string} */
let fixture;

/** The agent whose declared store the two arms move in and out of git. */
const AGENT = "probe-mem";
const INDEX_PATH = `.claude/agent-memory/${AGENT}/MEMORY.md`;

/**
 * @param {string} relativePath
 * @param {string} contents
 */
function write(relativePath, contents) {
  const target = path.join(fixture, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

/** @param {string[]} args */
function git(args) {
  execFileSync("git", args, { cwd: fixture, stdio: "pipe" });
}

/** @returns {{ status: number, output: string }} */
function runGate() {
  const result = spawnSync(
    process.execPath,
    [path.join(fixture, "scripts", "verify-agent-frontmatter.mjs")],
    {
      cwd: fixture,
      encoding: "utf8",
    },
  );
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agents-verify-runner-"));

  // The runner resolves its repo root from its own location, so it has to live
  // inside the fixture. Copy the real thing rather than a stand-in: a stand-in
  // could not regress.
  fs.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(scriptsDir, "verify-agent-frontmatter.mjs"),
    path.join(fixture, "scripts", "verify-agent-frontmatter.mjs"),
  );
  fs.cpSync(path.join(scriptsDir, "lib"), path.join(fixture, "scripts", "lib"), {
    recursive: true,
  });

  write(
    `.claude/agents/${AGENT}.md`,
    [
      "---",
      `name: ${AGENT}`,
      'description: "A throwaway agent that declares a project-scope memory store so the tracked-ness of its index can be measured."',
      "tools: Read, Write, Edit, Bash",
      "model: haiku",
      "memory: project",
      "---",
      "",
      "Body.",
    ].join("\n"),
  );
  // checkClaudeMdTable requires the table and disk to name the same set.
  write(
    "CLAUDE.md",
    ["| Agent | Purpose |", "|-------|---------|", `| \`${AGENT}\` | Probe |`].join("\n"),
  );

  git(["init", "--quiet"]);
  git(["add", "scripts", ".claude/agents", "CLAUDE.md"]);

  // Present on disk from here on, in BOTH arms. The pointed-at file has to exist
  // too: #1206 resolves every index pointer against disk in both directions, so a
  // store whose index names a file that was never written is itself a failure.
  write(`.claude/agent-memory/${AGENT}/thing.md`, "# Thing\n");
  write(INDEX_PATH, "- [Thing](thing.md) - hook\n");
});

afterAll(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe("verify-agent-frontmatter runner: rule B asks git (Issue #1168)", () => {
  /** Proves the two arms differ ONLY in tracking, not in file content. */
  let digestWhileUntracked = "";

  it("FAILS while the index is present on disk but untracked", () => {
    const onDisk = path.join(fixture, ...INDEX_PATH.split("/"));
    expect(fs.existsSync(onDisk)).toBe(true); // the old fs.existsSync probe would pass here
    digestWhileUntracked = fs.readFileSync(onDisk, "utf8");

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain(`${INDEX_PATH} is not tracked in git`);
    expect(output).toContain("git add");
  });

  it("PASSES once git tracks the very same bytes", () => {
    git(["add", INDEX_PATH]);

    const onDisk = path.join(fixture, ...INDEX_PATH.split("/"));
    // The file was neither rewritten nor touched between the arms; only the index
    // changed. If this ever diverges, the test is measuring the wrong thing.
    expect(fs.readFileSync(onDisk, "utf8")).toBe(digestWhileUntracked);

    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("All agent frontmatter is valid");
  });

  it("FAILS again when the index is untracked once more, with the file untouched", () => {
    git(["rm", "--cached", "--quiet", INDEX_PATH]);

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("is not tracked in git");
  });
});

/**
 * The #1180 rule's other half lives in the runner: the pure core cannot see a skill
 * unless something reads `SKILL.md` off disk and hands it over. `checkAgent` defaults
 * `skillFiles` to `{}`, so a runner that forgets to supply it produces a gate that
 * passes on every tree — the same silent fail-open shape #1168 found in rule B's
 * `fs.existsSync` probe, and unit tests over the core cannot catch it by construction.
 *
 * So the real runner is executed against a real skill file, mutated between arms. The
 * agent, its body and its `tools:` are identical in all three; only the skill's
 * instruction changes.
 */
describe("verify-agent-frontmatter runner: transitive MCP reachability (Issue #1180)", () => {
  const MCP_AGENT = "probe-mcp";
  const SKILL = "probe-skill";
  const SKILL_PATH = `.github/skills/${SKILL}/SKILL.md`;
  const LINK_PATH = `.claude/skills/${SKILL}`;
  /** Reached only from `SKILL`'s body — never from the agent's. */
  const HANDOFF = "probe-handoff";
  const HANDOFF_MCP = "Comment with `mcp_github_add_issue_comment`.";

  /** @param {string} instruction */
  function writeSkill(instruction) {
    write(
      SKILL_PATH,
      ["---", `name: ${SKILL}`, "---", "", "## Publish", "", instruction].join("\n"),
    );
  }

  beforeAll(() => {
    write(
      `.claude/agents/${MCP_AGENT}.md`,
      [
        "---",
        `name: ${MCP_AGENT}`,
        'description: "A throwaway agent with an allowlist naming no MCP pattern, told to invoke a skill whose body is mutated between arms."',
        "tools: Read, Bash, Skill",
        "model: haiku",
        "---",
        "",
        `Invoke the \`/${SKILL}\` skill for the full procedure.`,
      ].join("\n"),
    );
    write(
      "CLAUDE.md",
      [
        "| Agent | Purpose |",
        "|-------|---------|",
        `| \`${AGENT}\` | Probe |`,
        `| \`${MCP_AGENT}\` | Probe |`,
      ].join("\n"),
    );
    // The runner prefers `.claude/skills/<name>/SKILL.md` and falls back to
    // `.github/skills/`. Use a real symlink so the preferred branch is the one under
    // test — that is what a working checkout has (#1142).
    fs.mkdirSync(path.join(fixture, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(
      path.join("..", "..", ".github", "skills", SKILL),
      path.join(fixture, ...LINK_PATH.split("/")),
    );
    // Rule B is not what is under test here, so satisfy it once and leave it satisfied.
    git(["add", INDEX_PATH]);
  });

  it("FAILS when the invoked skill instructs an MCP tool the agent cannot reach", () => {
    writeSkill("Create the review with `mcp_github_pull_request_review_write`.");

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain(`${MCP_AGENT}: the body says to invoke "/${SKILL}"`);
    expect(output).toContain(`${SKILL_PATH}:7`);
    expect(output).toContain("mcp_github_pull_request_review_write");
  });

  it("PASSES when the same line is rewritten to gh", () => {
    writeSkill("Create the review with `gh api --method POST ... --input review.json`.");

    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("All agent frontmatter is valid");
  });

  it("PASSES when the MCP instruction returns but is marked main-session only", () => {
    writeSkill(
      "The main session may use `mcp_github_pull_request_review_write`. <!-- mcp: main-session only -->",
    );

    const { status } = runGate();
    expect(status).toBe(0);
  });

  it("FAILS again once the marker is removed, with the instruction unchanged", () => {
    writeSkill("The main session may use `mcp_github_pull_request_review_write`.");

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("mcp_github_pull_request_review_write");
  });

  /**
   * The skill -> skill hop. The agent body names only `/probe-skill`; the offending
   * instruction lives in `/probe-handoff`, which nothing but `probe-skill` mentions.
   * A one-hop rule reads `probe-skill` as clean and exits 0 — which is the live shape
   * of `code-review` -> `resolve-pr-comments`, the one such edge in the tree.
   */
  it("FAILS on a violation reachable ONLY through a skill -> skill handoff", () => {
    writeSkill("Hand off to the `/probe-handoff` skill for the publishing form.");
    write(
      `.github/skills/${HANDOFF}/SKILL.md`,
      ["---", `name: ${HANDOFF}`, "---", "", "## Publish", "", HANDOFF_MCP].join("\n"),
    );

    const { status, output } = runGate();
    expect(status).toBe(1);
    // The message must name the path, not just the offending skill: the reader's
    // first thought is "my body never mentions that skill".
    expect(output).toContain(`hands off to "/${HANDOFF}"`);
    expect(output).toContain(`.github/skills/${HANDOFF}/SKILL.md:7`);
    expect(output).toContain("mcp_github_add_issue_comment");
  });

  it("PASSES once the handed-off skill's line is rewritten to gh, hop intact", () => {
    write(
      `.github/skills/${HANDOFF}/SKILL.md`,
      [
        "---",
        `name: ${HANDOFF}`,
        "---",
        "",
        "## Publish",
        "",
        "Comment with `gh pr comment {N} --body-file body.md`.",
      ].join("\n"),
    );

    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("All agent frontmatter is valid");
  });

  /**
   * The second fail-open, one level up from the one these arms already close:
   * `readSkillNames()` used to `catch { return []; }`, so an unreadable
   * `.claude/skills/` emptied `skillFiles` and silenced BOTH this rule and #1162's
   * with a clean exit 0. The skill file itself is untouched here — only the symlink
   * tree it is discovered through disappears.
   */
  it("FAILS with .claude/skills/ removed entirely — the violation is still found", () => {
    write(
      `.github/skills/${HANDOFF}/SKILL.md`,
      ["---", `name: ${HANDOFF}`, "---", "", "## Publish", "", HANDOFF_MCP].join("\n"),
    );
    fs.rmSync(path.join(fixture, ".claude", "skills"), { recursive: true, force: true });

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("mcp_github_add_issue_comment");
  });
});

/**
 * The agent-memory budget, per-entry cap and archive rules (Issue #1206).
 *
 * ## Why the real runner, in its own repository
 *
 * These rules are half core and half runner. The core decides *whether* a store is
 * over budget; the runner decides *which stores exist and what is in them*, and
 * that second half is where every fail-open in this repo has lived — `skillFiles`
 * defaulting to `{}` (#1168), `readSkillNames` swallowing a missing directory
 * (#1180), a diff-side and a disk-side filter disagreeing (#1192). A core test
 * cannot see any of them, because the core takes the runner's answer as input.
 *
 * So every arm below runs `verify-agent-frontmatter.mjs` for real, and every one
 * of them is a **mutation with a restore arm** — the restore is what proves the
 * mutation caused the failure rather than some unrelated drift in the fixture.
 *
 * Two arms mutate **identity** rather than content: a memory file renamed with its
 * bytes untouched, and the store *directory* renamed. #1192's matrix was strong and
 * still missed three bypasses because every arm changed content and none changed
 * which file counted.
 *
 * This fixture is deliberately its own repository rather than the shared one above:
 * those describes mutate their fixture in sequence and end in a failing state.
 */
describe("verify-agent-frontmatter runner: memory index budget (Issue #1206)", () => {
  const STORE = "probe-budget";
  const STORE_DIR = `.claude/agent-memory/${STORE}`;
  const INDEX = `${STORE_DIR}/MEMORY.md`;
  const ARCHIVE = `${STORE_DIR}/ARCHIVE.md`;
  /** Under budget (15,100 B) and under the 15,750 B warning line. */
  const BASELINE_ENTRIES = 100;

  /** @type {string} */
  let repo;

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

  /** @returns {{ status: number, output: string }} */
  function run() {
    const result = spawnSync(
      process.execPath,
      [path.join(repo, "scripts", "verify-agent-frontmatter.mjs")],
      { cwd: repo, encoding: "utf8" },
    );
    return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  /**
   * One index line padded to an exact UTF-8 byte length, so every threshold arm
   * lands on a known side of the boundary rather than near it.
   *
   * @param {number} i
   * @param {number} [bytes]
   */
  function entry(i, bytes = MEMORY_ENTRY_MAX_BYTES) {
    const prefix = `- [Entry ${i}](mem_${i}.md) — `;
    return prefix + "h".repeat(bytes - Buffer.byteLength(prefix, "utf8"));
  }

  /** Rewrite the index and the memory files to exactly `count` entries. */
  function writeStore(count, { entryBytes = MEMORY_ENTRY_MAX_BYTES } = {}) {
    fs.mkdirSync(abs(STORE_DIR), { recursive: true });
    for (const name of fs.readdirSync(abs(STORE_DIR))) {
      if (name.startsWith("mem_")) fs.rmSync(abs(`${STORE_DIR}/${name}`));
    }
    const lines = [];
    for (let i = 0; i < count; i += 1) {
      lines.push(entry(i, entryBytes));
      put(`${STORE_DIR}/mem_${i}.md`, `# Entry ${i}\n`);
    }
    put(INDEX, `${lines.join("\n")}\n`);
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "agents-verify-budget-"));
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(scriptsDir, "verify-agent-frontmatter.mjs"),
      path.join(repo, "scripts", "verify-agent-frontmatter.mjs"),
    );
    fs.cpSync(path.join(scriptsDir, "lib"), path.join(repo, "scripts", "lib"), { recursive: true });

    put(
      `.claude/agents/${STORE}.md`,
      [
        "---",
        `name: ${STORE}`,
        'description: "A throwaway agent with a project-scope memory store, so the budget and per-entry rules can be measured against a real index."',
        "tools: Read, Write, Edit, Bash",
        "model: haiku",
        "memory: project",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    put("CLAUDE.md", ["| Agent | Purpose |", "|---|---|", `| \`${STORE}\` | Probe |`].join("\n"));

    writeStore(BASELINE_ENTRIES);
    execFileSync("git", ["init", "--quiet"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it("PASSES a store that is under budget with every pointer resolving both ways", () => {
    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain(`Memory store ${STORE_DIR}/: ${BASELINE_ENTRIES} file(s), index`);
    expect(output).toContain("All agent frontmatter is valid");
  });

  // --- budget ---------------------------------------------------------------

  it("FAILS once the index crosses the budget, naming the store, size and budget", () => {
    writeStore(130); // 130 x 151 B = 19,630 B
    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(`${INDEX} is 19630 bytes`);
    expect(output).toContain(`over the ${MEMORY_INDEX_BUDGET_BYTES}-byte budget`);
    expect(output).toContain("ARCHIVE.md");
  });

  it("PASSES again once the index is trimmed back — the mutation caused the failure", () => {
    writeStore(BASELINE_ENTRIES);
    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain("All agent frontmatter is valid");
  });

  it("WARNS on approach without failing", () => {
    writeStore(105); // 15,855 B — past the 15,750 B warning line, under budget
    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain("WARNING:");
    expect(output).toContain(`under the ${MEMORY_INDEX_BUDGET_BYTES}-byte budget`);
    writeStore(BASELINE_ENTRIES);
  });

  // --- per-entry cap ---------------------------------------------------------

  it("FAILS on one entry over the cap, with the index still far under budget", () => {
    const lines = fs.readFileSync(abs(INDEX), "utf8").split("\n");
    lines[7] = `${lines[7]}h`; // 151 bytes
    put(INDEX, lines.join("\n"));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(`${INDEX}:8 is 151 bytes`);
    expect(output).toContain(`over the ${MEMORY_ENTRY_MAX_BYTES}-byte per-entry cap`);
    // The budget rule must NOT be what fired — this arm is about the cap alone.
    expect(output).not.toContain(`over the ${MEMORY_INDEX_BUDGET_BYTES}-byte budget`);
  });

  it("PASSES with the same entry one byte shorter", () => {
    writeStore(BASELINE_ENTRIES);
    const { status } = run();
    expect(status).toBe(0);
  });

  it("FAILS a bullet that is not a pointer, so the cap cannot be side-stepped", () => {
    const lines = fs.readFileSync(abs(INDEX), "utf8").split("\n");
    lines.splice(3, 0, `- ${"prose ".repeat(80)}`);
    put(INDEX, lines.join("\n"));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("is a bullet but not a pointer");
  });

  // --- the fail-open arms ----------------------------------------------------

  it("FAILS when MEMORY.md is deleted and the memory files remain", () => {
    writeStore(BASELINE_ENTRIES);
    fs.rmSync(abs(INDEX));

    const { status, output } = run();
    expect(status).toBe(1);
    // A missing file is not a file under budget.
    expect(output).toContain(`holds ${BASELINE_ENTRIES} memory file(s) but no MEMORY.md`);
    expect(output).not.toContain("All agent frontmatter is valid");
  });

  it("FAILS when MEMORY.md is present but unreadable", () => {
    // A directory in its place: present as a directory entry, EISDIR on read. The
    // gate has to tell "present but unreadable" from "absent", or an unreadable
    // index reads as an empty store and sails under budget.
    fs.mkdirSync(abs(INDEX));
    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(`${INDEX} exists but could not be read`);
    fs.rmSync(abs(INDEX), { recursive: true });
  });

  it("PASSES once the index is restored, proving both arms above were the mutation", () => {
    writeStore(BASELINE_ENTRIES);
    const { status } = run();
    expect(status).toBe(0);
  });

  it("PASSES an empty store directory — #1163 removed code-review's scope, the harness still makes it", () => {
    const empty = ".claude/agent-memory/probe-empty";
    fs.mkdirSync(abs(empty), { recursive: true });
    const { status, output } = run();
    expect(status).toBe(0);
    // "absent", not "unreadable": a legitimately empty store must not be logged
    // in the vocabulary the hard-fail arm uses for an index it could not read.
    expect(output).toContain(`Memory store ${empty}/: 0 file(s), index absent`);
    expect(output).not.toContain(`${empty}/: 0 file(s), index unreadable`);
    fs.rmSync(abs(empty), { recursive: true });
  });

  // --- identity mutations ----------------------------------------------------

  it("FAILS when a memory file is RENAMED with its bytes untouched", () => {
    const before = fs.readFileSync(abs(`${STORE_DIR}/mem_3.md`), "utf8");
    fs.renameSync(abs(`${STORE_DIR}/mem_3.md`), abs(`${STORE_DIR}/mem_renamed.md`));
    expect(fs.readFileSync(abs(`${STORE_DIR}/mem_renamed.md`), "utf8")).toBe(before);

    const { status, output } = run();
    expect(status).toBe(1);
    // Both directions must fire: a dangling pointer AND an unreachable file.
    expect(output).toContain('points at "mem_3.md", which does not exist');
    expect(output).toContain(`${STORE_DIR}/mem_renamed.md is in neither MEMORY.md nor ARCHIVE.md`);

    fs.renameSync(abs(`${STORE_DIR}/mem_renamed.md`), abs(`${STORE_DIR}/mem_3.md`));
    expect(run().status).toBe(0);
  });

  it("FAILS when the store DIRECTORY is renamed, though every byte in it is intact", () => {
    // git still tracks `<STORE>/MEMORY.md`, so the disk walk and git disagree.
    // Without the cross-check this exits 0: no store on disk means no store to
    // check, which is precisely the "default that means nothing to check" shape.
    fs.renameSync(abs(STORE_DIR), abs(".claude/agent-memory/probe-moved"));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(`${INDEX} is tracked in git but no store was read`);
    expect(output).toContain("did not run");

    fs.renameSync(abs(".claude/agent-memory/probe-moved"), abs(STORE_DIR));
    expect(run().status).toBe(0);
  });

  it("FAILS when .claude/agent-memory/ cannot be read as a directory", () => {
    // The one arm the cross-check does NOT cover, and the reason the runner
    // rethrows instead of catching everything: `readdirSync` erroring for any
    // reason other than ENOENT must be a reported defect, not an empty list.
    // A plain file in the directory's place gives a deterministic ENOTDIR on
    // every platform, without depending on chmod semantics or on the uid.
    fs.cpSync(abs(".claude/agent-memory"), abs(".claude/agent-memory-backup"), {
      recursive: true,
    });
    fs.rmSync(abs(".claude/agent-memory"), { recursive: true });
    fs.writeFileSync(abs(".claude/agent-memory"), "not a directory\n", "utf8");

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("Cannot read the agent-memory stores");
    expect(output).toContain("is not a store that is under budget");

    fs.rmSync(abs(".claude/agent-memory"));
    fs.renameSync(abs(".claude/agent-memory-backup"), abs(".claude/agent-memory"));
    expect(run().status).toBe(0);
  });

  it("FAILS when .claude/agent-memory/ is removed entirely", () => {
    fs.cpSync(abs(".claude/agent-memory"), abs(".claude/agent-memory-backup"), {
      recursive: true,
    });
    fs.rmSync(abs(".claude/agent-memory"), { recursive: true });

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("is tracked in git but no store was read");

    fs.renameSync(abs(".claude/agent-memory-backup"), abs(".claude/agent-memory"));
    expect(run().status).toBe(0);
  });

  // --- one enumeration predicate, both sides ---------------------------------
  //
  // The control for this whole section is the "RENAMED with its bytes untouched"
  // arm above: an unindexed *regular top-level `.md`* fails. Each arm here is the
  // same unreachable file wearing a different hat, and each one exited 0 silently
  // before the disk side and the pointer side were made to share `memoryEntryPath`
  // — the shape #1192 shipped three bypasses with. None of them is reachable by
  // mutating a branch, because the defect lived in a filter expression.

  it("FAILS on an unindexed file that is not .md — the old filter saw only .md", () => {
    put(`${STORE_DIR}/orphan.txt`, "unreachable\n");
    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(`${STORE_DIR}/orphan.txt is in neither MEMORY.md nor ARCHIVE.md`);

    fs.rmSync(abs(`${STORE_DIR}/orphan.txt`));
    expect(run().status).toBe(0);
  });

  it.skipIf(!SYMLINKS_SUPPORTED)(
    "FAILS on an unindexed .md that is a SYMLINK — Dirent.isFile() is lstat, so it vanished",
    () => {
      put(`${STORE_DIR}/target-of-link.md`, "# Linked\n");
      fs.symlinkSync("target-of-link.md", abs(`${STORE_DIR}/linked.md`));
      // Both are unreachable: the arm is that the symlink is *seen at all*.
      const { status, output } = run();
      expect(status).toBe(1);
      expect(output).toContain(`${STORE_DIR}/linked.md is in neither MEMORY.md nor ARCHIVE.md`);

      fs.rmSync(abs(`${STORE_DIR}/linked.md`));
      fs.rmSync(abs(`${STORE_DIR}/target-of-link.md`));
      expect(run().status).toBe(0);
    },
  );

  it("FAILS on an unindexed .md in a SUBDIRECTORY — readdirSync was not recursive", () => {
    put(`${STORE_DIR}/nested/deep.md`, "# Deep\n");
    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(`${STORE_DIR}/nested/deep.md is in neither MEMORY.md nor ARCHIVE.md`);

    fs.rmSync(abs(`${STORE_DIR}/nested`), { recursive: true });
    expect(run().status).toBe(0);
  });

  it.skipIf(!SYMLINKS_SUPPORTED)(
    "resolves a pointer at a SYMLINKED file instead of calling it missing",
    () => {
      // The mirror image, and worse than silence: a *wrong* message. The file is
      // right there; only the enumerator could not see it.
      put(`${STORE_DIR}/target-of-link.md`, "# Linked\n");
      fs.symlinkSync("target-of-link.md", abs(`${STORE_DIR}/linked.md`));
      const lines = fs.readFileSync(abs(INDEX), "utf8").split("\n");
      lines.splice(
        1,
        0,
        "- [Linked](linked.md) — via a symlink",
        "- [Target](target-of-link.md) — the target",
      );
      put(INDEX, lines.join("\n"));

      const { status, output } = run();
      expect(status).toBe(0);
      expect(output).not.toContain('points at "linked.md", which does not exist');

      writeStore(BASELINE_ENTRIES);
      fs.rmSync(abs(`${STORE_DIR}/linked.md`));
      fs.rmSync(abs(`${STORE_DIR}/target-of-link.md`));
      expect(run().status).toBe(0);
    },
  );

  it("resolves a pointer at a SUBDIRECTORY file instead of calling it missing", () => {
    put(`${STORE_DIR}/nested/deep.md`, "# Deep\n");
    const lines = fs.readFileSync(abs(INDEX), "utf8").split("\n");
    lines.splice(1, 0, "- [Deep](nested/deep.md) — one directory down");
    put(INDEX, lines.join("\n"));

    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).not.toContain("does not exist");

    writeStore(BASELINE_ENTRIES);
    fs.rmSync(abs(`${STORE_DIR}/nested`), { recursive: true });
    expect(run().status).toBe(0);
  });

  it("IGNORES a dot-file, so the widened predicate stays satisfiable on macOS", () => {
    // Widening past `.md` must not make the gate unsatisfiable for anyone whose
    // Finder has visited the directory. A `.DS_Store` is not a memory entry.
    put(`${STORE_DIR}/.DS_Store`, "Finder junk\n");
    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain(`Memory store ${STORE_DIR}/: ${BASELINE_ENTRIES} file(s)`);
    fs.rmSync(abs(`${STORE_DIR}/.DS_Store`));
  });

  // --- duplicates and double-listing -----------------------------------------

  it("FAILS on the same pointer twice in the index — a duplicate pays the budget twice", () => {
    const lines = fs.readFileSync(abs(INDEX), "utf8").split("\n");
    lines.splice(1, 0, lines[0]);
    put(INDEX, lines.join("\n"));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain('lists "mem_0.md" a second time');

    writeStore(BASELINE_ENTRIES);
    expect(run().status).toBe(0);
  });

  it("FAILS when a pointer is in BOTH the index and the archive — that is not retired", () => {
    const retained = fs.readFileSync(abs(INDEX), "utf8").split("\n")[4];
    put(ARCHIVE, `# Retired pointers — not loaded into context\n\n${retained}\n`);

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(`still lists "mem_4.md" although ${ARCHIVE} has retired it`);

    fs.rmSync(abs(ARCHIVE));
    expect(run().status).toBe(0);
  });

  // --- the archive -----------------------------------------------------------

  it("PASSES when an entry is retired to ARCHIVE.md — the file stays, the pointer moves", () => {
    const lines = fs.readFileSync(abs(INDEX), "utf8").split("\n");
    const retired = lines.splice(5, 1)[0];
    put(INDEX, lines.join("\n"));
    put(ARCHIVE, `# Retired pointers — not loaded into context\n\n${retired}\n`);

    const { status, output } = run();
    expect(status).toBe(0);
    expect(fs.existsSync(abs(`${STORE_DIR}/mem_5.md`))).toBe(true);
    expect(output).toContain("All agent frontmatter is valid");
  });

  it("FAILS once the archived pointer is deleted too — archiving is not deleting", () => {
    put(ARCHIVE, "# Retired pointers — not loaded into context\n");
    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(`${STORE_DIR}/mem_5.md is in neither MEMORY.md nor ARCHIVE.md`);
  });

  it("does not charge ARCHIVE.md against the budget", () => {
    const retired = entry(5);
    // An archive many times the budget, with the index unchanged and under it.
    const filler = Array.from({ length: 400 }, () => "x".repeat(120)).join("\n");
    put(ARCHIVE, `# Retired\n\n${retired}\n\n${filler}\n`);
    expect(Buffer.byteLength(fs.readFileSync(abs(ARCHIVE), "utf8"), "utf8")).toBeGreaterThan(
      MEMORY_INDEX_BUDGET_BYTES,
    );

    const { status } = run();
    expect(status).toBe(0);
  });
});

/**
 * A skill body the runner cannot read is UNKNOWN, not clean (Issue #1215).
 *
 * ## What reading missed
 *
 * `checkSkillMcpReachability` skipped any reachable skill with no text, on a written
 * rationale that survived review twice: "`checkAgent`'s marked-skill rule already
 * reports an invocation of a skill that does not exist". That is true of a *name* that
 * is not a skill. It is false of a skill whose **directory exists and whose body does
 * not** — the name is known, the marked-skill rule is satisfied, and the #1180 walk
 * silently has nothing to walk. Measured on the real runner before the fix: the tree
 * whose `SKILL.md` instructs `mcp_github_pull_request_review_write` exits 1; delete
 * that one file and the same tree exits **0**, printing "All agent frontmatter is
 * valid".
 *
 * The second arm is the same shape one level out. `readSkillNames()` unions both skill
 * roots and `continue`d past an unreadable one — deliberately, so a missing symlink
 * tree cannot hide a skill. With *both* roots unreadable the union collapses to `[]`,
 * and `checkAgent` gates its marked-skill rule on `skillNames.length > 0`, so an agent
 * invoking a skill that has never existed exits 0. The core guard is right — it cannot
 * distinguish "no list supplied" from "could not enumerate" — so the runner decides it.
 *
 * Every arm mutates and restores, and two mutate **identity** rather than content: the
 * skill directory is renamed with its bytes untouched, and the roots are made
 * unreadable with every file inside them intact. #1192's matrix was strong and still
 * missed three bypasses because every arm changed what was inside a file and none
 * changed which file counted.
 */
describe("verify-agent-frontmatter runner: an unreadable skill body fails closed (Issue #1215)", () => {
  const AGENT_NAME = "probe-body";
  const SKILL = "probe-body-skill";
  const SKILL_DIR_REL = `.github/skills/${SKILL}`;
  const SKILL_MD = `${SKILL_DIR_REL}/SKILL.md`;
  const MCP_LINE = "Create the review with `mcp_github_pull_request_review_write`.";
  const GH_LINE = "Create the review with `gh api --method POST ... --input review.json`.";

  /** @type {string} */
  let repo;

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

  /** @param {string} instruction */
  function writeSkill(instruction) {
    put(SKILL_MD, ["---", `name: ${SKILL}`, "---", "", "## Publish", "", instruction].join("\n"));
  }

  /** @param {string} bodyLine */
  function writeAgent(bodyLine) {
    put(
      `.claude/agents/${AGENT_NAME}.md`,
      [
        "---",
        `name: ${AGENT_NAME}`,
        'description: "A throwaway agent whose tools allowlist names no MCP pattern, told to invoke a skill whose body is present, absent or unreadable across the arms."',
        "tools: Read, Bash, Skill",
        "model: haiku",
        "---",
        "",
        bodyLine,
      ].join("\n"),
    );
  }

  /** @returns {{ status: number, output: string }} */
  function run() {
    const result = spawnSync(
      process.execPath,
      [path.join(repo, "scripts", "verify-agent-frontmatter.mjs")],
      { cwd: repo, encoding: "utf8" },
    );
    return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "agents-verify-body-"));
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(scriptsDir, "verify-agent-frontmatter.mjs"),
      path.join(repo, "scripts", "verify-agent-frontmatter.mjs"),
    );
    fs.cpSync(path.join(scriptsDir, "lib"), path.join(repo, "scripts", "lib"), { recursive: true });

    writeAgent(`Invoke the \`/${SKILL}\` skill for the full procedure.`);
    put(
      "CLAUDE.md",
      ["| Agent | Purpose |", "|-------|---------|", `| \`${AGENT_NAME}\` | Probe |`].join("\n"),
    );
    writeSkill(GH_LINE);
    execFileSync("git", ["init", "--quiet"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it("PASSES on the baseline tree, and FAILS when the readable body instructs MCP", () => {
    expect(run().status).toBe(0);

    writeSkill(MCP_LINE);
    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("mcp_github_pull_request_review_write");

    writeSkill(GH_LINE);
    expect(run().status).toBe(0);
  });

  it("FAILS when the skill directory exists but SKILL.md is ABSENT", () => {
    fs.rmSync(abs(SKILL_MD));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(`the body says to invoke "/${SKILL}"`);
    expect(output).toContain("could not be read");
  });

  it("PASSES again once the very same body is restored", () => {
    writeSkill(GH_LINE);
    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain("All agent frontmatter is valid");
  });

  it("FAILS when SKILL.md is present but UNREADABLE (a directory — EISDIR)", () => {
    fs.rmSync(abs(SKILL_MD));
    fs.mkdirSync(abs(SKILL_MD));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("could not be read");

    fs.rmSync(abs(SKILL_MD), { recursive: true });
    writeSkill(GH_LINE);
    expect(run().status).toBe(0);
  });

  /**
   * Identity, not content: the bytes of `SKILL.md` never change: only the directory
   * name they sit under does, so the agent's `/probe-body-skill` no longer names
   * anything. A rule that read the body without checking which skill it belonged to
   * would stay green here.
   */
  it("FAILS when the skill DIRECTORY is renamed, its bytes untouched", () => {
    const before = fs.readFileSync(abs(SKILL_MD), "utf8");
    fs.renameSync(abs(SKILL_DIR_REL), abs(".github/skills/probe-body-skill-renamed"));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(`which is not a skill`);

    fs.renameSync(abs(".github/skills/probe-body-skill-renamed"), abs(SKILL_DIR_REL));
    expect(fs.readFileSync(abs(SKILL_MD), "utf8")).toBe(before);
    expect(run().status).toBe(0);
  });

  /**
   * The union's design intent, asserted so the fix above cannot quietly become an
   * over-block: ONE unreadable root is tolerated, because the other still answers the
   * question. `.claude/skills/` is the one Claude Code resolves and the one a fresh
   * clone may not have materialised at all.
   */
  it("PASSES with .claude/skills/ absent — one readable root still answers", () => {
    fs.mkdirSync(abs(".claude/skills"), { recursive: true });
    fs.symlinkSync(path.join("..", "..", SKILL_DIR_REL), abs(`.claude/skills/${SKILL}`));
    expect(run().status).toBe(0);

    fs.rmSync(abs(".claude/skills"), { recursive: true, force: true });
    expect(run().status).toBe(0);

    // And the rule is still live through the surviving root.
    writeSkill(MCP_LINE);
    expect(run().status).toBe(1);
    writeSkill(GH_LINE);
    expect(run().status).toBe(0);
  });

  it("FAILS when NEITHER skill root can be read, with an invocation that names nothing", () => {
    writeAgent("Invoke the `/ghost-skill` skill for the full procedure.");
    // Control: with the roots readable, the marked-skill rule catches it.
    const control = run();
    expect(control.status).toBe(1);
    expect(control.output).toContain("which is not a skill");

    // Identity mutation: every file inside the roots is intact; only the roots
    // themselves stop being directories.
    fs.rmSync(abs(".github/skills"), { recursive: true, force: true });
    fs.writeFileSync(abs(".github/skills"), "not a directory", "utf8");
    fs.writeFileSync(abs(".claude/skills"), "not a directory", "utf8");

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("Cannot enumerate skills");

    // Restore: the roots become readable again and the ORIGINAL problem returns —
    // proving the arm above measured enumeration, not the ghost invocation.
    fs.rmSync(abs(".claude/skills"));
    fs.rmSync(abs(".github/skills"));
    writeSkill(GH_LINE);
    const restored = run();
    expect(restored.status).toBe(1);
    expect(restored.output).toContain("which is not a skill");

    writeAgent(`Invoke the \`/${SKILL}\` skill for the full procedure.`);
    expect(run().status).toBe(0);
  });
});

/**
 * The second agent surface, end to end through the real runner (Issue #1282).
 *
 * ## Why this cannot be a unit test
 *
 * `verifyAgents` defaults `copilotAgentFiles` to `{}`, and `verifyCopilotSurface` is
 * deliberately inert on an empty map — a repository need not have a Copilot surface. That
 * makes "the runner forgot to gather the directory" and "the directory is legitimately
 * absent" identical from inside the core, which is exactly the shape #1180's `skillFiles`
 * default had and #1215 found eight more of. A deletability sweep confirmed it rather than
 * assumed it: deleting the `verifyCopilotSurface(...)` call from `verifyAgents` left the
 * entire unit suite green.
 *
 * So the real script runs against a throwaway repository carrying both directories, and
 * every arm mutates and restores. Two mutate **identity** rather than content — a twin is
 * deleted with its bytes untouched elsewhere, and a marker moves surface — because #1192's
 * matrix missed three bypasses while changing only what was inside files.
 */
describe("verify-agent-frontmatter runner: the Copilot agent surface (Issue #1282)", () => {
  const NAME = "probe-surface";
  const SOLO = "probe-solo";
  const CLAUDE_FILE = `.claude/agents/${NAME}.md`;
  const COPILOT_FILE = `.github/agents/${NAME}.agent.md`;
  const SOLO_FILE = `.github/agents/${SOLO}.agent.md`;
  const MARKER = "<!-- surface: copilot-only — kept for the Copilot runtime, see #1282 -->";

  /** @type {string} */
  let repo;

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

  /** @param {string} displayName @param {string} body */
  function copilotAgent(displayName, body) {
    return [
      "---",
      `name: ${displayName}`,
      'description: "A throwaway Copilot agent definition used to measure whether the runner reads the second agent surface at all."',
      "tools:",
      "  - read",
      "---",
      "",
      body,
    ].join("\n");
  }

  /** @returns {{ status: number, output: string }} */
  function run() {
    const result = spawnSync(
      process.execPath,
      [path.join(repo, "scripts", "verify-agent-frontmatter.mjs")],
      { cwd: repo, encoding: "utf8" },
    );
    return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  /** Put the tree back in the state every arm starts from. */
  function baseline() {
    put(
      CLAUDE_FILE,
      [
        "---",
        `name: ${NAME}`,
        'description: "A throwaway Claude Code subagent paired with a Copilot twin so roster drift can be measured."',
        "tools: Read, Bash",
        "model: haiku",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    put(COPILOT_FILE, copilotAgent("Probe Surface", "Body."));
    put(SOLO_FILE, copilotAgent("Probe Solo", `${MARKER}\n\nBody.`));
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "agents-verify-surface-"));
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(scriptsDir, "verify-agent-frontmatter.mjs"),
      path.join(repo, "scripts", "verify-agent-frontmatter.mjs"),
    );
    fs.cpSync(path.join(scriptsDir, "lib"), path.join(repo, "scripts", "lib"), { recursive: true });

    baseline();
    put(
      "CLAUDE.md",
      ["| Agent | Purpose |", "|-------|---------|", `| \`${NAME}\` | Probe |`].join("\n"),
    );
    execFileSync("git", ["init", "--quiet"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it("PASSES on a paired roster with one justified Copilot-only agent", () => {
    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain(`2 agent(s) in .github/agents/`);
  });

  it("FAILS when the Copilot twin is deleted — identity, not content", () => {
    fs.rmSync(abs(COPILOT_FILE));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(`${COPILOT_FILE} does not`);

    baseline();
    expect(run().status).toBe(0);
  });

  it("FAILS when a Copilot agent is added with no Claude twin and no marker", () => {
    put(`.github/agents/probe-orphan.agent.md`, copilotAgent("Probe Orphan", "Body."));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(".claude/agents/probe-orphan.md does not");

    fs.rmSync(abs(".github/agents/probe-orphan.agent.md"));
    expect(run().status).toBe(0);
  });

  it("FAILS when the exemption marker is removed from the solo agent", () => {
    put(SOLO_FILE, copilotAgent("Probe Solo", "Body."));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("surface: copilot-only");

    baseline();
    expect(run().status).toBe(0);
  });

  it("FAILS when the marker moves to the surface the agent is ABSENT from", () => {
    put(
      SOLO_FILE,
      copilotAgent("Probe Solo", "<!-- surface: claude-only — see #1282 -->\n\nBody."),
    );

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("names the surface the agent is");

    baseline();
    expect(run().status).toBe(0);
  });

  it("FAILS on a dangling handoffs[].agent reference", () => {
    put(
      COPILOT_FILE,
      [
        "---",
        "name: Probe Surface",
        'description: "A throwaway Copilot agent definition whose handoff names an agent that was never created."',
        "tools:",
        "  - read",
        "handoffs:",
        "  - label: Go",
        "    agent: Ghost Agent",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("ghost-agent.agent.md does not exist");

    baseline();
    expect(run().status).toBe(0);
  });

  it("FAILS when the surface is deleted wholesale but a document still claims it", () => {
    put("AGENTS.md", "Custom agents live in `.github/agents/*.agent.md`.\n");
    // With the docs claiming it, an empty directory is a defect rather than a silence.
    fs.rmSync(abs(".github/agents"), { recursive: true });

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("still tell a reader it does");

    baseline();
    expect(run().status).toBe(0);
  });

  it("FAILS CLOSED when .github/agents/ is present but UNREADABLE, not merely absent", () => {
    // ENOENT is a knowable answer — no Copilot surface — and the arm below relies on that.
    // ENOTDIR/EACCES is not, and must exit 1 with its own message rather than being folded
    // into "absent". A panel on #1282 measured that flipping the ENOENT test to always-true
    // left the whole suite green, and that `checkSurfaceDocumented` masked the effect in
    // this repository, so the distinction had no test of its own.
    fs.rmSync(abs(".github/agents"), { recursive: true });
    fs.writeFileSync(abs(".github/agents"), "not a directory", "utf8");

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("Cannot read the Copilot agent surface");

    fs.rmSync(abs(".github/agents"));
    baseline();
    expect(run().status).toBe(0);
  });

  it("FAILS when only a SKILL.md claims the surface — the loop that reads them is real", () => {
    // `readCopilotSurfaceDocs` gathers every SKILL.md as well as the two instruction files,
    // and a deletability sweep found that loop removable with the suite green (#1282). It
    // matters most here: the skills spell the reference as a bare `<name>.agent.md` rather
    // than as a path, and they are the documents most likely to be left dangling.
    fs.rmSync(abs("AGENTS.md"), { force: true });
    put(
      ".github/skills/probe-surface-skill/SKILL.md",
      [
        "---",
        "name: probe-surface-skill",
        'description: "A throwaway skill that names a Copilot agent by filename, the way six real ones do."',
        "---",
        "",
        "Execute with the **Probe Surface** agent (`probe-surface.agent.md`).",
      ].join("\n"),
    );
    fs.rmSync(abs(".github/agents"), { recursive: true });

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain(".github/skills/probe-surface-skill/SKILL.md");

    fs.rmSync(abs(".github/skills/probe-surface-skill"), { recursive: true });
    baseline();
    expect(run().status).toBe(0);
  });

  it("PASSES with the surface absent once nothing claims it exists", () => {
    fs.rmSync(abs("AGENTS.md"), { force: true });
    fs.rmSync(abs(".github/agents"), { recursive: true });

    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain("(none)");

    baseline();
    expect(run().status).toBe(0);
  });
});
