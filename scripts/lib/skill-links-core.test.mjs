import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LINK_DIR,
  MAX_DESCRIPTION_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  SOURCE_DIR,
  SYMLINK_MODE,
  MODEL_INVOCATION_GUARD,
  checkFrontmatter,
  checkModelInvocationGuard,
  classifyEntry,
  expectedLinkTarget,
  extractAgentFileReferences,
  extractMcpServerReferences,
  parseFrontmatter,
  verifySkillLinks,
} from "./skill-links-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A description long enough to clear the floor, for fixtures. */
const GOOD_DESCRIPTION =
  "Use when asked to do the specific thing this skill exists for, and not otherwise.";

/**
 * @param {Partial<{ name: string, description: string, extra: string }>} parts
 */
function skillDoc({ name = "demo", description = GOOD_DESCRIPTION, extra = "" } = {}) {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# Body\n`;
}

describe("expectedLinkTarget", () => {
  it("hops two levels up so the link survives a clone into any directory", () => {
    expect(expectedLinkTarget("code-issue")).toBe("../../.github/skills/code-issue");
  });
});

describe("parseFrontmatter", () => {
  it("reads simple key/value scalars", () => {
    const { found, fields } = parseFrontmatter(skillDoc({ name: "alpha" }));
    expect(found).toBe(true);
    expect(fields.name).toBe("alpha");
    expect(fields.description).toBe(GOOD_DESCRIPTION);
  });

  it("strips matching double and single quotes", () => {
    const { fields } = parseFrontmatter(`---\nname: "alpha"\ndescription: 'beta'\n---\n`);
    expect(fields.name).toBe("alpha");
    expect(fields.description).toBe("beta");
  });

  it("leaves a lone quote alone rather than truncating the value", () => {
    const { fields } = parseFrontmatter(`---\nname: it's\n---\n`);
    expect(fields.name).toBe("it's");
  });

  it("ignores comment lines and blank lines", () => {
    const { fields } = parseFrontmatter(
      `---\n# why this is off\n\nname: alpha\ndisable-model-invocation: true\n---\n`,
    );
    expect(fields.name).toBe("alpha");
    expect(fields["disable-model-invocation"]).toBe("true");
    expect(fields["# why this is off"]).toBeUndefined();
  });

  it("ignores indented lines belonging to a nested structure", () => {
    const { fields } = parseFrontmatter(`---\nname: alpha\nmetadata:\n  owner: platform\n---\n`);
    expect(fields.owner).toBeUndefined();
    expect(fields.metadata).toBe("");
  });

  it("skips lines with no colon", () => {
    const { fields } = parseFrontmatter(`---\nname: alpha\nnonsense\n---\n`);
    expect(Object.keys(fields)).toEqual(["name"]);
  });

  it("drops an inline comment from an unquoted scalar, as YAML does, and says so", () => {
    const { fields, commentTruncated } = parseFrontmatter(
      `---\ndescription: Opens a PR that says "Closes #N". Then stops.\n---\n`,
    );
    expect(fields.description).toBe('Opens a PR that says "Closes');
    expect(commentTruncated).toEqual(["description"]);
  });

  it("keeps a hash inside a quoted scalar", () => {
    const { fields, commentTruncated } = parseFrontmatter(
      `---\ndescription: 'Opens a PR that says "Closes #N". Then stops.'\n---\n`,
    );
    expect(fields.description).toBe('Opens a PR that says "Closes #N". Then stops.');
    expect(commentTruncated).toEqual([]);
  });

  it("leaves a hash with no preceding space alone", () => {
    const { fields, commentTruncated } = parseFrontmatter(`---\nname: issue#1142\n---\n`);
    expect(fields.name).toBe("issue#1142");
    expect(commentTruncated).toEqual([]);
  });

  it("reports not-found when there is no opening fence", () => {
    expect(parseFrontmatter("# Just a heading\n").found).toBe(false);
  });

  it("reports not-found when the fence is never closed", () => {
    expect(parseFrontmatter("---\nname: alpha\n").found).toBe(false);
  });

  it("reports not-found for a non-string input", () => {
    expect(parseFrontmatter(undefined).found).toBe(false);
    expect(parseFrontmatter(42).fields).toEqual({});
  });

  it("handles CRLF line endings, which is how the file arrives on Windows", () => {
    const { found, fields } = parseFrontmatter(
      "---\r\nname: alpha\r\ndescription: beta\r\n---\r\n",
    );
    expect(found).toBe(true);
    expect(fields.name).toBe("alpha");
  });
});

describe("checkFrontmatter", () => {
  it("passes a well-formed skill", () => {
    expect(checkFrontmatter("demo", skillDoc())).toEqual([]);
  });

  it("flags an unreadable SKILL.md", () => {
    expect(checkFrontmatter("demo", null)[0]).toContain("missing or unreadable");
  });

  it("flags a file with no frontmatter block", () => {
    expect(checkFrontmatter("demo", "# No fence\n")[0]).toContain(
      "no closed --- frontmatter block",
    );
  });

  it("flags a missing name", () => {
    expect(checkFrontmatter("demo", `---\ndescription: ${GOOD_DESCRIPTION}\n---\n`)).toContainEqual(
      expect.stringContaining('missing "name"'),
    );
  });

  it("flags a name that disagrees with the directory, since /invocation uses the directory", () => {
    expect(checkFrontmatter("demo", skillDoc({ name: "other" }))).toContainEqual(
      expect.stringContaining('but the directory is "demo"'),
    );
  });

  it("flags a missing description", () => {
    expect(checkFrontmatter("demo", `---\nname: demo\n---\n`)).toContainEqual(
      expect.stringContaining('missing "description"'),
    );
  });

  it("flags a title-shaped description, which is the regression #1142 guards against", () => {
    const problems = checkFrontmatter("demo", skillDoc({ description: "Code issue workflow" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`under the ${MIN_DESCRIPTION_LENGTH}-char floor`);
    expect(problems[0]).toContain("Use when");
  });

  it("flags an unquoted description whose tail YAML eats as a comment", () => {
    const problems = checkFrontmatter(
      "demo",
      `---\nname: demo\ndescription: ${GOOD_DESCRIPTION} It opens a PR saying "Closes #N".\n---\n`,
    );
    expect(problems).toContainEqual(
      expect.stringContaining("YAML discards everything from the hash onward"),
    );
  });

  it("flags a description past the listing cap, where the tail is silently truncated", () => {
    const problems = checkFrontmatter(
      "demo",
      skillDoc({ description: "x".repeat(MAX_DESCRIPTION_LENGTH + 1) }),
    );
    expect(problems[0]).toContain("listing cap");
  });

  it("accepts a description exactly at the cap", () => {
    expect(
      checkFrontmatter("demo", skillDoc({ description: "x".repeat(MAX_DESCRIPTION_LENGTH) })),
    ).toEqual([]);
  });
});

describe("classifyEntry", () => {
  const base = {
    name: "demo",
    indexMode: SYMLINK_MODE,
    indexTarget: expectedLinkTarget("demo"),
    worktreeKind: /** @type {const} */ ("symlink"),
    skillMdReadable: true,
  };

  it("accepts a committed symlink that resolves to a readable SKILL.md", () => {
    const result = classifyEntry(base);
    expect(result.status).toBe("ok");
    expect(result.detail).toBe(
      `${LINK_DIR}/demo -> ${SOURCE_DIR}/demo`.replace(SOURCE_DIR, `../../${SOURCE_DIR}`),
    );
  });

  it("accepts a directory that resolves, which is how a Windows junction presents", () => {
    expect(classifyEntry({ ...base, worktreeKind: "directory" }).status).toBe("ok");
  });

  it("rejects an untracked skill — the exact state that made 12 skills invisible", () => {
    const result = classifyEntry({ ...base, indexMode: null, indexTarget: null });
    expect(result.status).toBe("broken");
    expect(result.detail).toContain("is not tracked");
    expect(result.detail).toContain("ln -s ../../.github/skills/demo");
  });

  it("rejects a committed regular file, which would be a forkable copy", () => {
    const result = classifyEntry({ ...base, indexMode: "100644" });
    expect(result.status).toBe("broken");
    expect(result.detail).toContain("drift");
  });

  it("rejects a symlink pointing somewhere else", () => {
    const result = classifyEntry({ ...base, indexTarget: "../../elsewhere/demo" });
    expect(result.status).toBe("broken");
    expect(result.detail).toContain("expected");
  });

  it("rejects a link that resolves but whose SKILL.md does not read", () => {
    const result = classifyEntry({ ...base, skillMdReadable: false });
    expect(result.status).toBe("broken");
    expect(result.detail).toContain("does not read");
  });

  it("reports a core.symlinks=false checkout as unmaterialized, not broken", () => {
    const result = classifyEntry({
      ...base,
      worktreeKind: "file",
      worktreeContent: `${expectedLinkTarget("demo")}\n`,
      skillMdReadable: false,
    });
    expect(result.status).toBe("unmaterialized");
    expect(result.detail).toContain("core.symlinks=false");
    expect(result.detail).toContain("The commit is correct");
    expect(result.detail).toContain("git config core.symlinks true");
  });

  it("rejects a plain file whose contents are NOT the link target", () => {
    const result = classifyEntry({
      ...base,
      worktreeKind: "file",
      worktreeContent: "# an actual file someone committed here\n",
    });
    expect(result.status).toBe("broken");
    expect(result.detail).toContain("is a file in the working tree");
  });

  it("rejects a missing working-tree entry", () => {
    const result = classifyEntry({ ...base, worktreeKind: "missing" });
    expect(result.status).toBe("broken");
    expect(result.detail).toContain("is a missing in the working tree");
  });
});

describe("verifySkillLinks", () => {
  /** @param {string[]} names */
  function healthyInput(names) {
    return {
      skillNames: names,
      indexEntries: Object.fromEntries(
        names.map((n) => [n, { mode: SYMLINK_MODE, target: expectedLinkTarget(n) }]),
      ),
      worktree: Object.fromEntries(
        names.map((n) => [n, { kind: "symlink", skillMdReadable: true }]),
      ),
      skillFiles: Object.fromEntries(names.map((n) => [n, skillDoc({ name: n })])),
    };
  }

  it("passes a fully linked library and reports one result per skill", () => {
    const report = verifySkillLinks(healthyInput(["beta", "alpha"]));
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.results.map((r) => r.name)).toEqual(["alpha", "beta"]);
  });

  it("fails when a skill has no link", () => {
    const input = healthyInput(["alpha"]);
    delete input.indexEntries.alpha;
    const report = verifySkillLinks(input);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("is not tracked");
  });

  it("fails when frontmatter is bad even though the link is fine", () => {
    const input = healthyInput(["alpha"]);
    input.skillFiles.alpha = skillDoc({ name: "alpha", description: "Alpha" });
    const report = verifySkillLinks(input);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("char floor");
  });

  it("warns but does not fail on an unmaterialized checkout", () => {
    const input = healthyInput(["alpha"]);
    input.worktree.alpha = {
      kind: "file",
      content: expectedLinkTarget("alpha"),
      skillMdReadable: false,
    };
    const report = verifySkillLinks(input);
    expect(report.ok).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.results[0].status).toBe("unmaterialized");
  });

  it("fails on a link with no corresponding source directory", () => {
    const report = verifySkillLinks({
      ...healthyInput(["alpha"]),
      extraLinkNames: ["ghost"],
    });
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("does not exist");
  });

  it("fails when the skill library is empty", () => {
    const report = verifySkillLinks({
      skillNames: [],
      indexEntries: {},
      worktree: {},
      skillFiles: {},
    });
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("No skills found");
  });
});

// Guards the real files, not a fixture. Runs on the Windows CI job too, where
// it is the check that survives even if the working-tree symlinks do not.
describe("the checked-in skill library", () => {
  const sourceRoot = path.join(repoRoot, ...SOURCE_DIR.split("/"));
  const names = fs
    .readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it("has at least the 13 skills moved under one roof by #1142", () => {
    expect(names.length).toBeGreaterThanOrEqual(13);
    expect(names).toContain("code-issue");
    expect(names).toContain("run-metis-dev");
  });

  it.each(names)("%s has a trigger-shaped description", (name) => {
    const text = fs.readFileSync(path.join(sourceRoot, name, "SKILL.md"), "utf8");
    expect(checkFrontmatter(name, text)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The disable-model-invocation convention (#1282)
// ---------------------------------------------------------------------------

/** A SKILL.md body with optional frontmatter extras. */
function skillBody({ guard = false, body = "" }) {
  return [
    "---",
    "name: sample",
    `description: ${GOOD_DESCRIPTION}`,
    ...(guard ? [`${MODEL_INVOCATION_GUARD}: true`] : []),
    "---",
    "",
    body,
  ].join("\n");
}

describe("extractMcpServerReferences", () => {
  it("reads the Claude Code mcp__server__tool spelling", () => {
    expect(extractMcpServerReferences("call `mcp__github__create_pull_request_review`")).toEqual([
      "github",
    ]);
  });

  it("reads the Copilot mcp_server_tool spelling", () => {
    expect(
      extractMcpServerReferences("`mcp_tavily_tavily_search` and `mcp_github_get_me`"),
    ).toEqual(["github", "tavily"]);
  });

  it("reads an explicit namespace glob", () => {
    expect(extractMcpServerReferences("the `talos_*` MCP tools")).toEqual(["talos"]);
    expect(extractMcpServerReferences("`mcp__playwright__*`")).toEqual(["playwright"]);
  });

  it("never treats the bare mcp namespace as a server", () => {
    // `mcp__*` is not matched by any pattern; `mcp_*` and `mcp_mcp_x` ARE, and capture
    // "mcp". Both spellings appear in this repo's prose, and only the explicit filter
    // stops them naming a phantom server called "mcp".
    expect(extractMcpServerReferences("agents declaring no `mcp__*` pattern")).toEqual([]);
    expect(extractMcpServerReferences("an agent with no `mcp_*` tool at all")).toEqual([]);
    expect(extractMcpServerReferences("`mcp_mcp_probe`")).toEqual([]);
  });

  it("does not match ordinary snake_case prose, which would flag healthy skills", () => {
    const prose =
      "`node_modules`, `user_story`, `api_spec`, `read_file`, `fetch_webpage`, " +
      "`browser_click`, `execution_subagent`, `sub_issues`";
    expect(extractMcpServerReferences(prose)).toEqual([]);
  });

  it("returns nothing for a non-string", () => {
    expect(extractMcpServerReferences(null)).toEqual([]);
  });
});

describe("extractAgentFileReferences", () => {
  it("finds every .agent.md reference, deduplicated", () => {
    const text =
      "run `test-orchestrator.agent.md`, then code-review.agent.md, then `test-orchestrator.agent.md`";
    expect(extractAgentFileReferences(text)).toEqual(["code-review", "test-orchestrator"]);
  });

  it("returns nothing for a non-string", () => {
    expect(extractAgentFileReferences(undefined)).toEqual([]);
  });
});

describe("checkModelInvocationGuard", () => {
  const reachable = { mcpServerNames: ["github", "playwright"], agentSlugs: ["code-review"] };

  it("passes a skill whose tooling all exists", () => {
    const text = skillBody({ body: "Execute with `code-review.agent.md` via `mcp__github__*`." });
    expect(checkModelInvocationGuard({ name: "code-review", text, ...reachable })).toEqual([]);
  });

  it("FAILS an unreachable MCP server with no guard", () => {
    const text = skillBody({ body: "Use the `talos_*` MCP tools." });
    const problems = checkModelInvocationGuard({ name: "test-planner", text, ...reachable });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("MCP server(s) talos not defined in .mcp.json");
    expect(problems[0]).toContain(MODEL_INVOCATION_GUARD);
  });

  it("PASSES the same skill once it carries the guard", () => {
    const text = skillBody({ guard: true, body: "Use the `talos_*` MCP tools." });
    expect(checkModelInvocationGuard({ name: "test-planner", text, ...reachable })).toEqual([]);
  });

  it("FAILS a reference to an agent file that does not exist", () => {
    const text = skillBody({ body: "Execute with `test-orchestrator.agent.md`." });
    const problems = checkModelInvocationGuard({ name: "test-planner", text, ...reachable });
    expect(problems[0]).toContain("test-orchestrator.agent.md do not exist");
  });

  it("names BOTH reasons when a skill has both kinds of gap", () => {
    const text = skillBody({ body: "`test-orchestrator.agent.md` calls `talos_*`." });
    const problems = checkModelInvocationGuard({ name: "test-planner", text, ...reachable });
    expect(problems[0]).toContain("talos");
    expect(problems[0]).toContain("test-orchestrator.agent.md");
  });

  it("is one-directional: a guard with fully reachable tooling is not a defect", () => {
    const text = skillBody({ guard: true, body: "Uses `mcp__github__*` only." });
    expect(checkModelInvocationGuard({ name: "repo-scaffold", text, ...reachable })).toEqual([]);
  });

  it("treats a guard value other than true as absent", () => {
    const text = [
      "---",
      "name: sample",
      `description: ${GOOD_DESCRIPTION}`,
      `${MODEL_INVOCATION_GUARD}: false`,
      "---",
      "Use `talos_*`.",
    ].join("\n");
    expect(checkModelInvocationGuard({ name: "s", text, ...reachable })).toHaveLength(1);
  });

  it("FAILS CLOSED when the MCP server list could not be enumerated", () => {
    const text = skillBody({ guard: true, body: "Use `mcp__github__*`." });
    const problems = checkModelInvocationGuard({
      name: "s",
      text,
      mcpServerNames: null,
      agentSlugs: [],
    });
    expect(problems[0]).toContain("could not be read");
  });

  it("FAILS CLOSED when the agent directories could not be enumerated", () => {
    const text = skillBody({ body: "Execute with `code-review.agent.md`." });
    const problems = checkModelInvocationGuard({
      name: "s",
      text,
      mcpServerNames: [],
      agentSlugs: null,
    });
    expect(problems[0]).toContain("could not be read");
  });

  it("stays quiet on an unenumerable list when the skill names no such tooling", () => {
    const text = skillBody({ body: "Plain prose, no tooling." });
    expect(
      checkModelInvocationGuard({ name: "s", text, mcpServerNames: null, agentSlugs: null }),
    ).toEqual([]);
  });

  it("leaves an unreadable body to checkFrontmatter rather than double-reporting", () => {
    expect(checkModelInvocationGuard({ name: "s", text: null, ...reachable })).toEqual([]);
  });
});

describe("verifySkillLinks wires the guard rule", () => {
  const linked = (name) => ({
    indexEntries: { [name]: { mode: SYMLINK_MODE, target: expectedLinkTarget(name) } },
    worktree: { [name]: { kind: "symlink", skillMdReadable: true } },
  });

  it("fails a linked, well-formed skill whose tooling is unreachable and unguarded", () => {
    const report = verifySkillLinks({
      skillNames: ["ghost"],
      ...linked("ghost"),
      skillFiles: {
        ghost: [
          "---",
          "name: ghost",
          `description: ${GOOD_DESCRIPTION}`,
          "---",
          "Use `talos_*`.",
        ].join("\n"),
      },
      mcpServerNames: ["github"],
      agentSlugs: [],
    });
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain(MODEL_INVOCATION_GUARD);
  });

  it("passes the same skill with the guard", () => {
    const report = verifySkillLinks({
      skillNames: ["ghost"],
      ...linked("ghost"),
      skillFiles: {
        ghost: [
          "---",
          "name: ghost",
          `description: ${GOOD_DESCRIPTION}`,
          `${MODEL_INVOCATION_GUARD}: true`,
          "---",
          "Use `talos_*`.",
        ].join("\n"),
      },
      mcpServerNames: ["github"],
      agentSlugs: [],
    });
    expect(report.ok).toBe(true);
  });
});
