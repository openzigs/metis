import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LENSES } from "./adversarial-tally-core.mjs";
import {
  AGENT_DIR,
  DURABLE_FINDING_MARKER,
  PANEL_HEAD_BLOB_ANTIPATTERN,
  PANEL_VOTER_AGENT,
  WORKTREE_ISOLATION_MARKER,
  MEMORY_ARCHIVE_FILE,
  MEMORY_DIR,
  MEMORY_ENTRY_MAX_BYTES,
  MEMORY_INDEX_BUDGET_BYTES,
  MEMORY_INDEX_BUDGET_FRACTION,
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_READ_LIMIT_BYTES,
  MEMORY_INDEX_WARN_BYTES,
  MEMORY_INDEX_WARN_FRACTION,
  MCP_MAIN_SESSION_MARKER,
  MEMORY_WRITE_TOOLS,
  MIN_DESCRIPTION_LENGTH,
  REPO_SCOPED_MEMORY,
  SKILL_DIR,
  SKILL_SOURCE_DIR,
  SKILL_TOOL,
  UNAVAILABLE_TOOLS,
  checkAgent,
  checkClaudeMdTable,
  checkDurableFindingReceiver,
  checkMemoryIndex,
  checkMemoryIndexes,
  checkMemoryStore,
  checkMemoryStoresGathered,
  checkPanelWorktreeIsolation,
  checkSkillMcpReachability,
  extractSkillReferences,
  extractTableAgents,
  findMcpInstructions,
  findPanelDispatchSites,
  hasMcpTools,
  isMcpToolName,
  resolveSkillClosure,
  isMemoryPathSegment,
  isMemoryWriteReachable,
  isToolReachable,
  memoryEntryPath,
  memoryIndexPath,
  parseBlockLists,
  parseMemoryPointers,
  parseTrackedPaths,
  utf8Bytes,
  selectMemoryIndexes,
  splitToolList,
  stripFrontmatter,
  toolBaseName,
  verifyAgents,
} from "./agent-frontmatter-core.mjs";
import { parseFrontmatter } from "./skill-links-core.mjs";

/** A description comfortably over the trigger floor, so length never confounds a case. */
const GOOD_DESCRIPTION =
  "Use when you need a senior reviewer to validate a pull request against its issue.";

/**
 * Build a valid agent file, overriding or removing individual frontmatter lines.
 *
 * @param {Record<string, string | null>} [overrides] null removes the key
 * @param {string} [body] body text after the frontmatter fence
 * @returns {string}
 */
function agentFile(overrides = {}, body = "Body text.") {
  /** @type {Record<string, string | null>} */
  const fields = {
    name: "code-review",
    description: `"${GOOD_DESCRIPTION}"`,
    // Deliberately free of Glob/Grep: the tool registry is measured not to
    // expose those (#1168), so a fixture naming them would fail every case at once.
    tools: "Read, Bash",
    model: "inherit",
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`);
  return ["---", ...lines, "---", "", body].join("\n");
}

/** The skills that exist in this repo's `.claude/skills/`, as the runner would supply them. */
const KNOWN_SKILLS = ["adversarial-review", "code-issue", "code-review", "epic-planner"];

describe("parseBlockLists", () => {
  it("collects a YAML block sequence", () => {
    const text = [
      "---",
      "name: ui-vision",
      "mcpServers:",
      "  - github",
      "  - playwright",
      "---",
    ].join("\n");
    expect(parseBlockLists(text).mcpServers).toEqual(["github", "playwright"]);
  });

  it("collects an inline flow sequence", () => {
    const text = ["---", 'mcpServers: [github, "playwright"]', "---"].join("\n");
    expect(parseBlockLists(text).mcpServers).toEqual(["github", "playwright"]);
  });

  it("records a bare key with no items as an empty list", () => {
    const text = ["---", "mcpServers:", "---"].join("\n");
    expect(parseBlockLists(text).mcpServers).toEqual([]);
  });

  it("stops collecting when a new top-level key appears", () => {
    const text = ["---", "mcpServers:", "  - github", "model: inherit", "  - stray", "---"].join(
      "\n",
    );
    expect(parseBlockLists(text).mcpServers).toEqual(["github"]);
  });

  it("does not read past the closing fence", () => {
    const text = ["---", "mcpServers:", "  - github", "---", "tags:", "  - body-list"].join("\n");
    const lists = parseBlockLists(text);
    expect(lists.mcpServers).toEqual(["github"]);
    expect(lists.tags).toBeUndefined();
  });

  it("returns nothing for a file with no frontmatter or a non-string", () => {
    expect(parseBlockLists("no fence here")).toEqual({});
    expect(parseBlockLists(undefined)).toEqual({});
  });

  it("ignores scalar values that are not sequences", () => {
    const text = ["---", "model: inherit", "---"].join("\n");
    expect(parseBlockLists(text)).toEqual({});
  });
});

describe("splitToolList", () => {
  it("splits a comma-separated list", () => {
    expect(splitToolList("Read, Bash, Grep")).toEqual(["Read", "Bash", "Grep"]);
  });

  it("does not split on commas inside Agent(...) restrictions", () => {
    expect(splitToolList("Read, Agent(Explore, Plan), Bash")).toEqual([
      "Read",
      "Agent(Explore, Plan)",
      "Bash",
    ]);
  });

  it("tolerates an unbalanced closing paren without going negative", () => {
    expect(splitToolList("Read), Bash")).toEqual(["Read)", "Bash"]);
  });

  it("returns an empty list for empty or non-string input", () => {
    expect(splitToolList("")).toEqual([]);
    expect(splitToolList("   ")).toEqual([]);
    expect(splitToolList(undefined)).toEqual([]);
  });
});

describe("toolBaseName", () => {
  it("strips an Agent(...) restriction", () => {
    expect(toolBaseName("Agent(Explore, Plan)")).toBe("Agent");
  });

  it("leaves a plain tool name alone", () => {
    expect(toolBaseName("Read")).toBe("Read");
  });
});

describe("stripFrontmatter", () => {
  it("returns everything after the closing fence", () => {
    expect(stripFrontmatter("---\nname: a\n---\nBody.\nMore.")).toBe("Body.\nMore.");
  });

  it("returns the whole text when there is no opening fence", () => {
    expect(stripFrontmatter("Just a body.")).toBe("Just a body.");
  });

  it("returns nothing when the fence never closes, so an unterminated header is not a body", () => {
    expect(stripFrontmatter("---\nname: a\n")).toBe("");
  });

  it("tolerates a non-string", () => {
    expect(stripFrontmatter(null)).toBe("");
  });
});

describe("extractSkillReferences", () => {
  it("finds the house-style instruction and marks it for existence checking", () => {
    const text = agentFile({}, "Invoke the `/code-review` skill for the full procedure.");
    expect(extractSkillReferences(text, KNOWN_SKILLS)).toEqual({
      references: ["code-review"],
      marked: ["code-review"],
    });
  });

  // code-issue's real shape: the workflow skill plus the adversarial panel.
  it("collects several references, sorted and de-duplicated", () => {
    const text = agentFile(
      {},
      [
        "Invoke the `/code-issue` skill for the full workflow.",
        "Invoke the `/adversarial-review` skill for the procedure.",
        "Re-read `/code-issue` if you lose the thread.",
      ].join("\n"),
    );
    expect(extractSkillReferences(text, KNOWN_SKILLS).references).toEqual([
      "adversarial-review",
      "code-issue",
    ]);
  });

  it("finds a slash reference with no backticks and any inflection of invoke", () => {
    const text = agentFile({}, "The agent invokes /epic-planner before writing anything.");
    expect(extractSkillReferences(text, KNOWN_SKILLS).references).toEqual(["epic-planner"]);
  });

  it("finds a backticked name paired with the word skill", () => {
    const text = agentFile({}, "Invoke the `code-review` skill first.");
    expect(extractSkillReferences(text, KNOWN_SKILLS)).toEqual({
      references: ["code-review"],
      marked: ["code-review"],
    });
  });

  it("is case-insensitive and normalises the captured name", () => {
    const text = agentFile({}, "Invoke the `/Code-Review` Skill.");
    expect(extractSkillReferences(text, KNOWN_SKILLS).references).toEqual(["code-review"]);
  });

  // The false-positive that would otherwise fail unrelated PRs: an unmarked name
  // in free prose is only a skill if a skill by that name actually exists.
  it("ignores unmarked prose that merely contains the word skill", () => {
    const text = agentFile({}, "Do not invoke the same skill twice in one run.");
    expect(extractSkillReferences(text, KNOWN_SKILLS).references).toEqual([]);
  });

  it("counts an unmarked name that is a real skill, but does not mark it", () => {
    const text = agentFile({}, "Invoke the code-review skill.");
    expect(extractSkillReferences(text, KNOWN_SKILLS)).toEqual({
      references: ["code-review"],
      marked: [],
    });
  });

  it("counts a bare backticked slash-name only when it is a real skill", () => {
    const real = agentFile({}, "The `/adversarial-review` panel is precision-first.");
    expect(extractSkillReferences(real, KNOWN_SKILLS).references).toEqual(["adversarial-review"]);

    const notASkill = agentFile({}, "Run `/mcp` to check server status.");
    expect(extractSkillReferences(notASkill, KNOWN_SKILLS).references).toEqual([]);
  });

  it("does not mistake a multi-segment route for a skill", () => {
    const text = agentFile({}, "Mounted under `/projects/:projectId/hooks`.");
    expect(extractSkillReferences(text, KNOWN_SKILLS).references).toEqual([]);
  });

  // A description is prose *about* the agent, not an instruction *to* it, so a
  // skill named there must not satisfy or trip the rule.
  it("scans only the body, never the frontmatter", () => {
    const text = agentFile(
      { description: '"Wraps the /code-review skill end to end for a pull request."' },
      "No instructions here.",
    );
    expect(extractSkillReferences(text, KNOWN_SKILLS).references).toEqual([]);
  });

  it("finds nothing when no skills are known and nothing is marked", () => {
    const text = agentFile({}, "Invoke the code-review skill.");
    expect(extractSkillReferences(text).references).toEqual([]);
  });
});

describe("checkAgent", () => {
  it("accepts a well-formed agent", () => {
    const result = checkAgent({ name: "code-review", text: agentFile() });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("reports an unreadable file", () => {
    const { problems } = checkAgent({ name: "ghost", text: null });
    expect(problems).toEqual([`${AGENT_DIR}/ghost.md is missing or unreadable`]);
  });

  it("reports a file with no closed frontmatter fence", () => {
    const { problems } = checkAgent({ name: "code-review", text: "---\nname: code-review\n" });
    expect(problems).toEqual(["code-review: has no closed --- frontmatter block"]);
  });

  // The #1142 bug, ported: in an UNQUOTED YAML scalar a space before `#` opens
  // an inline comment, so a description ending 'says "Closes #N".' is silently
  // cut at "Closes" — and `description` is the sole input to auto-delegation.
  it("fails an unquoted description truncated by a YAML inline comment", () => {
    const text = agentFile({
      description: "Implements an issue and opens a PR that says Closes #N at the end.",
    });
    const { problems } = checkAgent({ name: "code-review", text });
    expect(problems.some((p) => p.includes("YAML discards everything from the hash"))).toBe(true);
  });

  it("warns, but does not fail, when a non-description field is truncated", () => {
    const text = agentFile({ tools: "Read, Bash # nb: no writes" });
    const { problems, warnings } = checkAgent({ name: "code-review", text });
    expect(problems).toEqual([]);
    expect(warnings.some((w) => w.includes('"tools" is unquoted'))).toBe(true);
  });

  it("does not flag a quoted description containing a hash", () => {
    const text = agentFile({
      description: '"Implements an issue and opens a PR that says Closes #N at the end."',
    });
    expect(checkAgent({ name: "code-review", text }).problems).toEqual([]);
  });

  it("requires the frontmatter name to match the filename", () => {
    const { problems } = checkAgent({ name: "code-review", text: agentFile({ name: "reviewer" }) });
    expect(problems).toEqual([
      'code-review: frontmatter name is "reviewer" but the file is code-review.md',
    ]);
  });

  it("requires a name at all", () => {
    const { problems } = checkAgent({ name: "code-review", text: agentFile({ name: null }) });
    expect(problems).toContain('code-review: frontmatter is missing "name"');
  });

  it("requires a description", () => {
    const { problems } = checkAgent({
      name: "code-review",
      text: agentFile({ description: null }),
    });
    expect(problems).toContain('code-review: frontmatter is missing "description"');
  });

  it("rejects a description that is a title rather than a trigger", () => {
    const short = '"Reviews code."';
    expect(short.length - 2).toBeLessThan(MIN_DESCRIPTION_LENGTH);
    const { problems } = checkAgent({
      name: "code-review",
      text: agentFile({ description: short }),
    });
    expect(problems.some((p) => p.includes("under the 40-char floor"))).toBe(true);
  });

  it("rejects a misspelled model alias", () => {
    const { problems } = checkAgent({ name: "code-review", text: agentFile({ model: "sonnnet" }) });
    expect(problems.some((p) => p.includes('model "sonnnet"'))).toBe(true);
  });

  it("accepts a full model ID", () => {
    const { problems } = checkAgent({
      name: "code-review",
      text: agentFile({ model: "claude-opus-5" }),
    });
    expect(problems).toEqual([]);
  });

  it("warns when model is absent, because the default is the top tier", () => {
    const { problems, warnings } = checkAgent({
      name: "code-review",
      text: agentFile({ model: null }),
    });
    expect(problems).toEqual([]);
    expect(warnings.some((w) => w.includes("defaults to inherit"))).toBe(true);
  });

  it("rejects an invalid memory scope and accepts a valid one", () => {
    const bad = checkAgent({ name: "code-review", text: agentFile({ memory: "session" }) });
    expect(bad.problems.some((p) => p.includes('memory "session"'))).toBe(true);
    const good = checkAgent({
      name: "code-review",
      text: agentFile({ memory: "project", tools: "Read, Write, Edit" }),
      memoryIndexes: ["code-review"],
    });
    expect(good.problems).toEqual([]);
  });

  // The #1163 defect, end to end through checkAgent: `code-review` shipped
  // `memory: project` alongside `disallowedTools: Write, Edit`.
  it("fails the #1163 combination of a declared memory scope and a denied Write", () => {
    const text = agentFile({
      memory: "project",
      tools: "Read, Bash",
      disallowedTools: "Write, Edit",
    });
    const { problems } = checkAgent({
      name: "code-review",
      text,
      memoryIndexes: ["code-review"],
    });
    expect(problems.some((p) => p.includes("denies both Write and Edit"))).toBe(true);
  });

  it("does not run the memory-store checks when no memory scope is declared", () => {
    const text = agentFile({ tools: "Read, Bash", disallowedTools: "Write, Edit" });
    expect(checkAgent({ name: "code-review", text, memoryIndexes: [] }).problems).toEqual([]);
  });

  it("warns when there is no tools allowlist", () => {
    const { warnings } = checkAgent({ name: "code-review", text: agentFile({ tools: null }) });
    expect(warnings.some((w) => w.includes("inherits every tool"))).toBe(true);
  });

  it("rejects a tool that is both allowed and denied", () => {
    const text = agentFile({ tools: "Read, Write, Bash", disallowedTools: "Write, Edit" });
    const { problems } = checkAgent({ name: "code-review", text });
    expect(problems.some((p) => p.includes('"Write" is in both tools and disallowedTools'))).toBe(
      true,
    );
  });

  it("accepts a disallowedTools list that does not overlap the allowlist", () => {
    const text = agentFile({ tools: "Read, Bash", disallowedTools: "Write, Edit" });
    expect(checkAgent({ name: "code-review", text }).problems).toEqual([]);
  });

  it("compares Agent(...) against the denylist by its base name", () => {
    const text = agentFile({ tools: "Read, Agent(Explore)", disallowedTools: "Agent" });
    const { problems } = checkAgent({ name: "code-review", text });
    expect(problems.some((p) => p.includes('"Agent" is in both'))).toBe(true);
  });

  it("rejects an mcpServers entry that .mcp.json does not define", () => {
    const text = [
      "---",
      "name: ui-vision",
      `description: "${GOOD_DESCRIPTION}"`,
      "tools: Read, Bash",
      "model: inherit",
      "mcpServers:",
      "  - playwrite",
      "---",
      "",
    ].join("\n");
    const { problems } = checkAgent({
      name: "ui-vision",
      text,
      mcpServerNames: ["github", "playwright"],
    });
    expect(problems).toEqual([
      'ui-vision: mcpServers lists "playwrite", which .mcp.json does not define ' +
        "(known: github, playwright).",
    ]);
  });

  it("names the empty case when .mcp.json defines nothing", () => {
    const text = [
      "---",
      "name: a",
      `description: "${GOOD_DESCRIPTION}"`,
      "tools: Read",
      "model: inherit",
      "mcpServers:",
      "  - github",
      "---",
    ].join("\n");
    const { problems } = checkAgent({ name: "a", text, mcpServerNames: [] });
    expect(problems[0]).toContain("known: none");
  });

  it("accepts mcpServers entries that .mcp.json defines", () => {
    const text = [
      "---",
      "name: ui-vision",
      `description: "${GOOD_DESCRIPTION}"`,
      "tools: Read, Bash",
      "model: inherit",
      "mcpServers:",
      "  - github",
      "---",
      "",
    ].join("\n");
    const { problems } = checkAgent({
      name: "ui-vision",
      text,
      mcpServerNames: ["github", "playwright"],
    });
    expect(problems).toEqual([]);
  });

  // #1162, the exact shape that shipped in six of seven agents: the body says
  // "invoke the skill", the allowlist has no Skill, and nothing complained.
  it("rejects a body that invokes a skill when tools omits Skill", () => {
    const text = agentFile(
      { tools: "Read, Bash" },
      "Invoke the `/code-review` skill for the full procedure. Do **not** `Read` the SKILL.md.",
    );
    const { problems } = checkAgent({ name: "code-review", text, skillNames: KNOWN_SKILLS });
    expect(problems).toEqual([
      'code-review: the body says to invoke /code-review but tools does not list "Skill". ' +
        "An explicit tools allowlist is a whitelist, so this agent cannot invoke any skill — " +
        "add Skill or delete the instruction (#1162).",
    ]);
  });

  it("accepts the same body once Skill is in the allowlist", () => {
    const text = agentFile(
      { tools: `Read, Bash, ${SKILL_TOOL}` },
      "Invoke the `/code-review` skill for the full procedure.",
    );
    expect(checkAgent({ name: "code-review", text, skillNames: KNOWN_SKILLS }).problems).toEqual(
      [],
    );
  });

  it("names every referenced skill in one problem", () => {
    const text = agentFile(
      { name: "code-issue", tools: "Read, Bash" },
      "Invoke the `/code-issue` skill. Invoke the `/adversarial-review` skill for the panel.",
    );
    const { problems } = checkAgent({ name: "code-issue", text, skillNames: KNOWN_SKILLS });
    expect(problems[0]).toContain("invoke /adversarial-review, /code-issue");
  });

  // With `tools:` omitted the agent inherits Skill, so the instruction is
  // satisfiable and the rule must stay quiet — only the allowlist warning fires.
  it("does not fire when tools is omitted entirely, because Skill is inherited", () => {
    const text = agentFile({ tools: null }, "Invoke the `/code-review` skill.");
    const { problems, warnings } = checkAgent({
      name: "code-review",
      text,
      skillNames: KNOWN_SKILLS,
    });
    expect(problems).toEqual([]);
    expect(warnings.some((w) => w.includes("inherits every tool"))).toBe(true);
  });

  // adversarial-reviewer is deliberately self-contained: no skill instruction,
  // no Skill tool, and that combination must stay legal.
  it("leaves a self-contained agent with no skill instruction alone", () => {
    const text = agentFile(
      { name: "adversarial-reviewer", tools: "Read, Bash" },
      "You are one voter on one lens. Everything you need is in this prompt.",
    );
    const { problems } = checkAgent({
      name: "adversarial-reviewer",
      text,
      skillNames: KNOWN_SKILLS,
    });
    expect(problems).toEqual([]);
  });

  it("rejects a marked reference to a skill that does not exist on disk", () => {
    const text = agentFile(
      { tools: `Read, ${SKILL_TOOL}` },
      "Invoke the `/code-reviw` skill for the full procedure.",
    );
    const { problems } = checkAgent({ name: "code-review", text, skillNames: KNOWN_SKILLS });
    expect(problems).toEqual([
      `code-review: the body says to invoke "/code-reviw", which is not a skill in ${SKILL_DIR}/ ` +
        `(known: ${KNOWN_SKILLS.join(", ")}).`,
    ]);
  });

  it("skips the existence check when no skill list is supplied", () => {
    const text = agentFile(
      { tools: `Read, ${SKILL_TOOL}` },
      "Invoke the `/code-reviw` skill for the full procedure.",
    );
    expect(checkAgent({ name: "code-review", text }).problems).toEqual([]);
  });

  it("warns on a misspelled frontmatter key rather than failing", () => {
    const { problems, warnings } = checkAgent({
      name: "code-review",
      text: agentFile({ dissallowedTools: "Write" }),
    });
    expect(problems).toEqual([]);
    expect(
      warnings.some((w) => w.includes('unrecognised frontmatter key "dissallowedTools"')),
    ).toBe(true);
  });
});

describe("isToolReachable", () => {
  // `null` means "no `tools:` key at all", which inherits. An empty ARRAY means
  // the key is present with no value, which resolves to zero tools (#1168,
  // measured) — conflating the two is the bug this signature exists to prevent.
  it("treats a missing allowlist (null) as inheriting every tool", () => {
    expect(isToolReachable("Write", null, [])).toBe(true);
    expect(isToolReachable("Write", undefined, [])).toBe(true);
  });

  it("treats a present-but-empty allowlist as reaching nothing", () => {
    expect(isToolReachable("Write", [], [])).toBe(false);
    expect(isToolReachable("Read", [], [])).toBe(false);
  });

  it("excludes a tool the allowlist omits", () => {
    expect(isToolReachable("Write", ["Read", "Bash"], [])).toBe(false);
  });

  it("includes a tool the allowlist names", () => {
    expect(isToolReachable("Write", ["Read", "Write"], [])).toBe(true);
  });

  // disallowedTools is applied first, so it beats both an allowlist entry and
  // the inherit-everything default.
  it("lets the denylist win over the allowlist and over inheritance", () => {
    expect(isToolReachable("Write", ["Read", "Write"], ["Write"])).toBe(false);
    expect(isToolReachable("Write", null, ["Write"])).toBe(false);
  });
});

describe("isMemoryWriteReachable (Issue #1168)", () => {
  // The 2x2 measured on CLI 2.1.220, reading the resolved tool list off the
  // `system`/`init` line of `claude -p --agent <name> --output-format stream-json`.
  it("reports a write tool reachable when an allowlist merely omits it", () => {
    // MEASURED: `tools: Read, Bash` + `memory: project` resolved to
    // ["Read","Bash","Write","Edit"] — the memory protocol injects the write
    // tools straight past the allowlist.
    expect(isMemoryWriteReachable("Write", [])).toBe(true);
    expect(isMemoryWriteReachable("Edit", [])).toBe(true);
  });

  it("reports a write tool unreachable when disallowedTools names it", () => {
    // MEASURED: no `tools:` + `disallowedTools: Write, Edit` + `memory: project`
    // resolved to the full inherit set with Write and Edit absent.
    expect(isMemoryWriteReachable("Write", ["Write", "Edit"])).toBe(false);
    expect(isMemoryWriteReachable("Edit", ["Write", "Edit"])).toBe(false);
  });

  // It takes no allowlist parameter at all, so the arm cannot be reintroduced at
  // a call site. Pinning the arity keeps that structural guarantee under test.
  it("takes no allowlist parameter", () => {
    expect(isMemoryWriteReachable.length).toBe(1);
  });

  // The mutation this kills: reusing isToolReachable for the memory question,
  // which is what shipped in #1163 and would report a false positive on the
  // allowlist-omission shape.
  it("disagrees with isToolReachable on exactly the allowlist-omission shape", () => {
    expect(isToolReachable("Write", ["Read", "Bash"], [])).toBe(false);
    expect(isMemoryWriteReachable("Write", [])).toBe(true);
  });
});

describe("parseTrackedPaths (Issue #1168)", () => {
  it("splits the NUL-separated output of git ls-files -z", () => {
    expect(parseTrackedPaths("a/MEMORY.md\0b/MEMORY.md\0")).toEqual(["a/MEMORY.md", "b/MEMORY.md"]);
  });

  it("drops empty segments rather than emitting a bogus path", () => {
    expect(parseTrackedPaths("\0\0")).toEqual([]);
    expect(parseTrackedPaths("")).toEqual([]);
  });

  // A newline-splitting implementation would silently mangle any path
  // containing one; -z exists precisely so that cannot happen.
  it("does not split on newlines", () => {
    expect(parseTrackedPaths("odd\nname.md\0")).toEqual(["odd\nname.md"]);
  });

  it("returns nothing rather than throwing on bad input", () => {
    expect(parseTrackedPaths(null)).toEqual([]);
    expect(parseTrackedPaths(undefined)).toEqual([]);
  });
});

describe("checkDurableFindingReceiver (Issue #1168)", () => {
  const promising = agentFile({}, "End your report with a `Durable finding:` line.");
  const silent = agentFile({}, "Just review the PR.");

  it("fails when an agent promises the channel and CLAUDE.md documents no receiver", () => {
    const problems = checkDurableFindingReceiver({
      agentFiles: { "code-review": promising },
      claudeMd: "# METIS\n\nNothing about receiving anything.",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("code-review");
    expect(problems[0]).toContain(DURABLE_FINDING_MARKER);
  });

  it("passes when CLAUDE.md names the receiver", () => {
    expect(
      checkDurableFindingReceiver({
        agentFiles: { "code-review": promising },
        claudeMd: "A subagent's `Durable finding:` line is the dispatcher's to persist.",
      }),
    ).toEqual([]);
  });

  it("checks nothing when no agent promises the channel", () => {
    expect(
      checkDurableFindingReceiver({ agentFiles: { "code-review": silent }, claudeMd: "" }),
    ).toEqual([]);
  });

  it("names every promiser, so adding a second agent cannot hide behind the first", () => {
    const problems = checkDurableFindingReceiver({
      agentFiles: { "code-review": promising, "ui-vision": promising, research: silent },
      claudeMd: "",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("code-review");
    expect(problems[0]).toContain("ui-vision");
    expect(problems[0]).not.toContain("research");
  });

  // The marker must be read from the BODY, exactly like the skill rule: a
  // description mentioning the channel is prose about the agent, not a promise.
  it("ignores the marker when it appears only in the frontmatter", () => {
    const inFrontmatter = agentFile({ description: `"Emits Durable finding: lines."` }, "Body.");
    expect(checkDurableFindingReceiver({ agentFiles: { a: inFrontmatter }, claudeMd: "" })).toEqual(
      [],
    );
  });

  it("treats an unreadable CLAUDE.md as no receiver", () => {
    expect(
      checkDurableFindingReceiver({ agentFiles: { "code-review": promising }, claudeMd: null }),
    ).toHaveLength(1);
  });
});

describe("checkMemoryStore (Issue #1163)", () => {
  /** The frontmatter `code-issue` actually ships: writable, with a committed index. */
  /** The frontmatter shape `code-issue` ships, reduced to what this rule reads. */
  const writable = { disallowedBases: [] };

  it("passes a writable agent whose project store has a committed index", () => {
    const problems = checkMemoryStore({
      name: "code-issue",
      memory: "project",
      ...writable,
      memoryIndexes: ["code-issue"],
    });
    expect(problems).toEqual([]);
  });

  it("checks nothing when no memory scope is declared", () => {
    expect(
      checkMemoryStore({
        name: "code-review",
        memory: "",
        disallowedBases: ["Write", "Edit"],
        memoryIndexes: [],
      }),
    ).toEqual([]);
  });

  it("tolerates a non-string memory value", () => {
    expect(checkMemoryStore({ name: "a", memory: undefined, memoryIndexes: [] })).toEqual([]);
  });

  // An invalid scope is already reported by checkAgent; reporting it twice with
  // a second, differently-worded problem would just be noise.
  it("stays silent on an invalid scope rather than double-reporting it", () => {
    expect(
      checkMemoryStore({
        name: "a",
        memory: "session",
        disallowedBases: ["Write", "Edit"],
        memoryIndexes: [],
      }),
    ).toEqual([]);
  });

  // Rule A — the root cause of #1163, catchable from frontmatter alone.
  it("fails when disallowedTools denies both Write and Edit", () => {
    const problems = checkMemoryStore({
      name: "code-review",
      memory: "project",
      disallowedBases: ["Write", "Edit"],
      memoryIndexes: ["code-review"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("denies both Write and Edit");
  });

  // #1163 asserted the OPPOSITE here, on a probe subject (`code-review`) that
  // held an allowlist omission AND a denylist at once, so the evidence could not
  // attribute the denial to either arm. Measured separately for #1168 on CLI
  // 2.1.220: `tools: Read, Bash` + `memory: project` and no `disallowedTools`
  // resolves to ["Read","Bash","Write","Edit"], while the same allowlist WITHOUT
  // `memory:` resolves to ["Read","Bash"]. The memory protocol really does inject
  // the write tools past an allowlist omission, so this shape is legal — which is
  // why the rule takes no allowlist parameter at all and this call passes none.
  it("passes when nothing denies a write tool, whatever the allowlist omits", () => {
    const problems = checkMemoryStore({
      name: "research",
      memory: "project",
      disallowedBases: [],
      memoryIndexes: ["research"],
    });
    expect(problems).toEqual([]);
  });

  // Either tool alone is enough to reach the store, so denying just one must NOT
  // fire. Expressed as single denials because that is the only shape that can
  // catch `MEMORY_WRITE_TOOLS` being narrowed to one tool: with the list cut to
  // ["Write"], denying Write alone leaves nothing reachable and this fails.
  // (The pair of cases this replaced passed `toolBases`, which the rule ignores,
  // so both reduced to the same call and neither could fail — #1169 review.)
  it("passes when only Write is denied, because Edit still reaches the store", () => {
    const problems = checkMemoryStore({
      name: "a",
      memory: "project",
      disallowedBases: ["Write"],
      memoryIndexes: ["a"],
    });
    expect(problems).toEqual([]);
  });

  it("passes when only Edit is denied, because Write still reaches the store", () => {
    const problems = checkMemoryStore({
      name: "a",
      memory: "project",
      disallowedBases: ["Edit"],
      memoryIndexes: ["a"],
    });
    expect(problems).toEqual([]);
  });

  it("names both write tools, so neither can be dropped from the rule", () => {
    expect(MEMORY_WRITE_TOOLS).toEqual(["Write", "Edit"]);
  });

  it("applies the writability rule to every scope, not just project", () => {
    for (const memory of ["user", "project", "local"]) {
      const problems = checkMemoryStore({
        name: "a",
        memory,
        disallowedBases: ["Write", "Edit"],
        memoryIndexes: ["a"],
      });
      expect(problems.some((p) => p.includes("denies both Write and Edit"))).toBe(true);
    }
  });

  // Rule B — the literal acceptance criterion: a declared scope with no store.
  it("fails a project scope whose MEMORY.md index is absent", () => {
    const problems = checkMemoryStore({
      name: "code-review",
      memory: "project",
      ...writable,
      memoryIndexes: ["code-issue"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${MEMORY_DIR}/code-review/${MEMORY_INDEX_FILE}`);
  });

  it("reports both rules at once when both are broken", () => {
    const problems = checkMemoryStore({
      name: "code-review",
      memory: "project",
      disallowedBases: ["Write", "Edit"],
      memoryIndexes: [],
    });
    expect(problems).toHaveLength(2);
  });

  // `user` stores live under the home directory and `local` stores are
  // deliberately not committed, so neither is assertable from the repository.
  it("does not require a committed index for a non-repo-scoped store", () => {
    expect(REPO_SCOPED_MEMORY).toEqual(["project"]);
    for (const memory of ["user", "local"]) {
      expect(checkMemoryStore({ name: "a", memory, ...writable, memoryIndexes: [] })).toEqual([]);
    }
  });
});

describe("memoryIndexPath / selectMemoryIndexes (Issue #1163)", () => {
  it("points at the index file inside the agent's store", () => {
    expect(memoryIndexPath("code-issue")).toBe(".claude/agent-memory/code-issue/MEMORY.md");
  });

  // The mutation this exists to kill: probing the store DIRECTORY instead of the
  // index. The harness creates an empty directory at dispatch, so a
  // directory-only probe would call every declared store reachable.
  it("asks about the index file, never the bare directory", () => {
    /** @type {string[]} */
    const asked = [];
    selectMemoryIndexes(["code-issue", "ui-vision"], (p) => {
      asked.push(p);
      return false;
    });
    expect(asked).toEqual([
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/ui-vision/MEMORY.md",
    ]);
  });

  // And the mutation of returning every name regardless.
  it("keeps only the names whose index exists", () => {
    const exists = (/** @type {string} */ p) => p.includes("/code-issue/");
    expect(selectMemoryIndexes(["code-issue", "code-review", "ui-vision"], exists)).toEqual([
      "code-issue",
    ]);
  });

  it("returns nothing when the probe reports nothing exists", () => {
    expect(selectMemoryIndexes(["a", "b"], () => false)).toEqual([]);
  });

  it("returns nothing rather than throwing on bad input", () => {
    expect(selectMemoryIndexes(null, () => true)).toEqual([]);
    expect(selectMemoryIndexes(["a"], undefined)).toEqual([]);
  });

  // End to end through the check: the probe result is what decides rule B.
  it("drives the rule-B verdict it feeds", () => {
    const text = agentFile({ memory: "project", tools: "Read, Write, Edit" });
    const claudeMd = "| `code-review` | Review |";
    const agentFiles = { "code-review": text };

    const absent = verifyAgents({
      agentFiles,
      claudeMd,
      memoryIndexes: selectMemoryIndexes(["code-review"], () => false),
    });
    expect(absent.ok).toBe(false);

    const present = verifyAgents({
      agentFiles,
      claudeMd,
      memoryIndexes: selectMemoryIndexes(
        ["code-review"],
        (p) => p === memoryIndexPath("code-review"),
      ),
      // #1206: a tracked index with no gathered store is itself a failure.
      memoryStores: [{ store: "code-review" }],
    });
    expect(present.ok).toBe(true);
  });
});

describe("declared-but-unexposed tools (Issue #1168)", () => {
  it("names exactly the tools the registry is measured not to expose", () => {
    expect(UNAVAILABLE_TOOLS).toEqual(["Glob", "Grep"]);
  });

  it("fails an agent whose tools name a tool the build does not expose", () => {
    const { problems } = checkAgent({
      name: "code-review",
      text: agentFile({ tools: "Read, Bash, Glob, Grep" }),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Glob");
    expect(problems[0]).toContain("Grep");
    // The remedy must name the route that works, because the harness's own
    // error text does: "find files with `find` via the Bash tool instead".
    expect(problems[0]).toContain("Bash");
  });

  it("passes the same agent once the dead entries are removed", () => {
    expect(
      checkAgent({ name: "code-review", text: agentFile({ tools: "Read, Bash" }) }).problems,
    ).toEqual([]);
  });

  // Only the allowlist is a declaration of capability. A body that mentions the
  // names — including one that says NOT to use them — must stay legal.
  it("does not fire on a body that merely mentions the names", () => {
    const text = agentFile({ tools: "Read, Bash" }, "Glob and Grep are not exposed; use Bash.");
    expect(checkAgent({ name: "code-review", text }).problems).toEqual([]);
  });

  it("does not fire when tools is omitted, since nothing is being declared", () => {
    expect(checkAgent({ name: "code-review", text: agentFile({ tools: null }) }).problems).toEqual(
      [],
    );
  });
});

describe("tools present but empty (Issue #1168)", () => {
  // MEASURED on CLI 2.1.220: both `tools:` (bare) and `tools: []` resolve to a
  // tool list of length 0 — the agent can do nothing at all. Reading that as
  // inherit-everything is exactly backwards.
  it("fails a bare tools: key, which resolves to zero tools", () => {
    const { problems } = checkAgent({ name: "code-review", text: agentFile({ tools: "" }) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("present but lists nothing");
  });

  it("fails an explicit empty flow sequence the same way", () => {
    const { problems } = checkAgent({ name: "code-review", text: agentFile({ tools: "[]" }) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("present but lists nothing");
  });

  // The distinction the old `toolBases.length === 0` test could not make.
  it("keeps an omitted tools key as inherit-everything, with only a warning", () => {
    const { problems, warnings } = checkAgent({
      name: "code-review",
      text: agentFile({ tools: null }),
    });
    expect(problems).toEqual([]);
    expect(warnings.some((w) => w.includes("inherits every tool"))).toBe(true);
  });

  // An empty allowlist must not be laundered into "memory is fine": the agent
  // has no tools, so reporting the inert allowlist is the honest single problem.
  it("reports the empty allowlist rather than silently passing a memory scope", () => {
    const { problems } = checkAgent({
      name: "code-review",
      text: agentFile({ tools: "", memory: "project" }),
      memoryIndexes: ["code-review"],
    });
    expect(problems.some((p) => p.includes("present but lists nothing"))).toBe(true);
  });
});

describe("tools as a YAML block sequence (Issue #1168)", () => {
  /**
   * `parseFrontmatter` reports a block-sequence value as an EMPTY scalar, because
   * it ignores indented lines — so the items must be recovered from
   * `parseBlockLists` or a legal, working shape reads as "declares nothing".
   * Measured on CLI 2.1.220: this shape resolves to `["Read","Bash"]`, a real
   * allowlist, so rejecting it would be over-blocking.
   *
   * @param {string} items
   * @param {string} [body]
   */
  function blockToolsAgent(items, body = "Body text.") {
    return [
      "---",
      "name: code-review",
      `description: "${GOOD_DESCRIPTION}"`,
      "tools:",
      items,
      "model: inherit",
      "---",
      "",
      body,
    ].join("\n");
  }

  it("accepts a block sequence as a real allowlist, not as zero tools", () => {
    const { problems } = checkAgent({
      name: "code-review",
      text: blockToolsAgent("  - Read\n  - Bash"),
    });
    expect(problems).toEqual([]);
  });

  // Proves the recovered list is actually USED, not merely tolerated: a dead tool
  // hidden in a block sequence must still be caught.
  it("applies the unavailable-tool rule to block-sequence entries", () => {
    const { problems } = checkAgent({
      name: "code-review",
      text: blockToolsAgent("  - Read\n  - Glob"),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Glob");
  });

  // And that it is treated as an ALLOWLIST (a whitelist), not as inheritance.
  it("applies the Skill-tool rule to block-sequence entries", () => {
    const { problems } = checkAgent({
      name: "code-review",
      text: blockToolsAgent("  - Read\n  - Bash", "Invoke the `/code-review` skill."),
      skillNames: KNOWN_SKILLS,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(SKILL_TOOL);
  });

  it("still fails a bare tools: key that opens no items", () => {
    const text = [
      "---",
      "name: code-review",
      `description: "${GOOD_DESCRIPTION}"`,
      "tools:",
      "model: inherit",
      "---",
      "",
      "Body text.",
    ].join("\n");
    const { problems } = checkAgent({ name: "code-review", text });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("present but lists nothing");
  });

  // The mirror of the bug: a block-sequence denylist read as empty would switch
  // the memory writability rule OFF, i.e. fail open.
  it("recovers a block-sequence disallowedTools so the memory rule still fires", () => {
    const text = [
      "---",
      "name: code-review",
      `description: "${GOOD_DESCRIPTION}"`,
      "tools: Read, Bash",
      "disallowedTools:",
      "  - Write",
      "  - Edit",
      "model: inherit",
      "memory: project",
      "---",
      "",
      "Body text.",
    ].join("\n");
    const { problems } = checkAgent({
      name: "code-review",
      text,
      memoryIndexes: ["code-review"],
    });
    expect(problems.some((p) => p.includes("denies both Write and Edit"))).toBe(true);
  });
});

describe("rule B asks git, not the filesystem (Issue #1168)", () => {
  // The message is the remedy, so it has to say WHICH state is wrong. An
  // untracked-but-present index is the demonstrated failure mode (ddbbc6ba
  // committed 23 orphaned memory files), and "does not exist" would send the
  // reader looking for a file that is sitting right there.
  it("blames tracking, not existence, and names the remedy", () => {
    const problems = checkMemoryStore({
      name: "code-review",
      memory: "project",
      disallowedBases: [],
      memoryIndexes: [],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("is not tracked in git");
    expect(problems[0]).toContain("git add");
  });
});

describe("extractTableAgents", () => {
  it("pulls backticked names from the first column", () => {
    const md = [
      "| Agent | Purpose |",
      "|-------|---------|",
      "| `code-issue` | Implement issues |",
      "| `ui-vision` | Visual QA |",
    ].join("\n");
    expect(extractTableAgents(md)).toEqual(["code-issue", "ui-vision"]);
  });

  it("ignores rows whose first cell is not a backticked name", () => {
    const md = ["| Domain | File |", "| TypeScript | x.md |", "| `go` | y.md |"].join("\n");
    expect(extractTableAgents(md)).toEqual(["go"]);
  });

  it("de-duplicates and tolerates a non-string", () => {
    expect(extractTableAgents("| `a` | x |\n| `a` | y |")).toEqual(["a"]);
    expect(extractTableAgents(null)).toEqual([]);
  });
});

describe("checkClaudeMdTable", () => {
  it("passes when the table and disk agree", () => {
    const md = "| `code-issue` | Implement |\n| `ui-vision` | QA |";
    expect(checkClaudeMdTable({ claudeMd: md, agentNames: ["code-issue", "ui-vision"] })).toEqual(
      [],
    );
  });

  it("reports an agent on disk with no table row", () => {
    const problems = checkClaudeMdTable({
      claudeMd: "| `code-issue` | Implement |",
      agentNames: ["code-issue", "research"],
    });
    expect(problems).toEqual([
      'CLAUDE.md\'s agent table has no row for "research", which exists on disk.',
    ]);
  });

  // The concrete #1145 failure: an agent was deleted and a reference survived.
  it("reports a table row for an agent that no longer exists", () => {
    const problems = checkClaudeMdTable({
      claudeMd: "| `code-issue` | Implement |\n| `orchestrator` | Drive everything |",
      agentNames: ["code-issue"],
    });
    expect(problems).toEqual([
      `CLAUDE.md's agent table lists "orchestrator", but ${AGENT_DIR}/orchestrator.md does not exist.`,
    ]);
  });

  it("reports an unreadable CLAUDE.md", () => {
    expect(checkClaudeMdTable({ claudeMd: null, agentNames: ["code-issue"] })).toEqual([
      "CLAUDE.md is missing or unreadable — cannot verify the agent table.",
    ]);
  });
});

describe("verifyAgents wires the durable-finding receiver (Issue #1168)", () => {
  // Testing only the pure function leaves the WIRING unfalsifiable: deleting the
  // `checkDurableFindingReceiver` call from `verifyAgents` kept every direct test
  // green. These two go through the top-level entry point, like the sibling
  // CLAUDE.md-table rule already does.
  const promising = agentFile({}, `End your report with a \`${DURABLE_FINDING_MARKER}\` line.`);
  const tableRow = "| `code-review` | Review |";

  it("fails end to end when CLAUDE.md documents no receiver", () => {
    const report = verifyAgents({
      agentFiles: { "code-review": promising },
      claudeMd: tableRow,
    });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes(DURABLE_FINDING_MARKER))).toBe(true);
  });

  it("passes end to end once CLAUDE.md names the receiver", () => {
    const report = verifyAgents({
      agentFiles: { "code-review": promising },
      claudeMd: `${tableRow}\n\nA subagent's \`${DURABLE_FINDING_MARKER}\` line is the dispatcher's to persist.`,
    });
    expect(report.ok).toBe(true);
  });
});

describe("verifyAgents", () => {
  it("passes a consistent set", () => {
    const report = verifyAgents({
      agentFiles: { "code-review": agentFile() },
      claudeMd: "| `code-review` | Review |",
    });
    expect(report).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it("fails when there are no agents at all", () => {
    const report = verifyAgents({ agentFiles: {}, claudeMd: "" });
    expect(report.ok).toBe(false);
    expect(report.problems).toContain(`No agent definitions found under ${AGENT_DIR}/.`);
  });

  it("aggregates per-agent problems and table drift together", () => {
    const report = verifyAgents({
      agentFiles: { "code-review": agentFile({ model: "sonnnet" }) },
      claudeMd: "| `orchestrator` | Gone |",
    });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes('model "sonnnet"'))).toBe(true);
    expect(report.problems.some((p) => p.includes("has no row for"))).toBe(true);
    expect(report.problems.some((p) => p.includes('lists "orchestrator"'))).toBe(true);
  });

  it("threads memoryIndexes down to the per-agent memory check", () => {
    const text = agentFile({ memory: "project", tools: "Read, Write, Edit" });
    const claudeMd = "| `code-review` | Review |";

    const missing = verifyAgents({ agentFiles: { "code-review": text }, claudeMd });
    expect(missing.ok).toBe(false);
    expect(missing.problems.some((p) => p.includes(MEMORY_INDEX_FILE))).toBe(true);

    const present = verifyAgents({
      agentFiles: { "code-review": text },
      claudeMd,
      memoryIndexes: ["code-review"],
      // The store has to be gathered too, or the #1206 cross-check fires — which
      // is the whole point of that rule.
      memoryStores: [{ store: "code-review" }],
    });
    expect(present.ok).toBe(true);
  });

  it("passes skillNames through to every agent", () => {
    const report = verifyAgents({
      agentFiles: {
        "code-review": agentFile({ tools: "Read, Bash" }, "Invoke the `/code-review` skill."),
      },
      skillNames: KNOWN_SKILLS,
      claudeMd: "| `code-review` | Review |",
    });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes('does not list "Skill"'))).toBe(true);
  });

  it("surfaces warnings without failing", () => {
    const report = verifyAgents({
      agentFiles: { "code-review": agentFile({ model: null }) },
      claudeMd: "| `code-review` | Review |",
    });
    expect(report.ok).toBe(true);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});

describe("memoryEntryPath — the one predicate both sides run (Issue #1206)", () => {
  it("canonicalises a store-relative path, either separator", () => {
    expect(memoryEntryPath("a.md")).toBe("a.md");
    expect(memoryEntryPath("nested/deep.md")).toBe("nested/deep.md");
    expect(memoryEntryPath("nested\\deep.md")).toBe("nested/deep.md");
  });

  it("is extension-agnostic — restricting to .md is what hid an unreachable file", () => {
    expect(memoryEntryPath("orphan.txt")).toBe("orphan.txt");
    expect(memoryEntryPath("notes")).toBe("notes");
  });

  it("rejects the index and the archive, which are not entries", () => {
    expect(memoryEntryPath(MEMORY_INDEX_FILE)).toBeNull();
    expect(memoryEntryPath(MEMORY_ARCHIVE_FILE)).toBeNull();
    // …but only at the store root: a nested one is an ordinary file.
    expect(memoryEntryPath(`nested/${MEMORY_INDEX_FILE}`)).toBe(`nested/${MEMORY_INDEX_FILE}`);
  });

  it("rejects anything that leaves the store or hides from it", () => {
    expect(memoryEntryPath("../elsewhere.md")).toBeNull();
    expect(memoryEntryPath("/abs.md")).toBeNull();
    expect(memoryEntryPath("./a.md")).toBeNull();
    expect(memoryEntryPath("a//b.md")).toBeNull();
    expect(memoryEntryPath(".DS_Store")).toBeNull();
    expect(memoryEntryPath(".git/config")).toBeNull();
    expect(memoryEntryPath("https://example.com/x.md")).toBeNull();
  });

  it("rejects non-strings and the empty string without throwing", () => {
    expect(memoryEntryPath("")).toBeNull();
    expect(memoryEntryPath(null)).toBeNull();
    expect(memoryEntryPath(undefined)).toBeNull();
    expect(memoryEntryPath(42)).toBeNull();
  });

  it("exposes the segment rule the runner uses to decide what to descend into", () => {
    expect(isMemoryPathSegment("nested")).toBe(true);
    expect(isMemoryPathSegment(".git")).toBe(false);
    expect(isMemoryPathSegment("..")).toBe(false);
    expect(isMemoryPathSegment(".")).toBe(false);
    expect(isMemoryPathSegment("")).toBe(false);
    expect(isMemoryPathSegment(null)).toBe(false);
  });
});

describe("memory index budget derivation (Issue #1206)", () => {
  /**
   * **What this pins is consistency, not computation.** A hand-typed `17_500`
   * satisfies the equality below exactly as well as the expression does —
   * measured: with both constants replaced by literals, the whole suite stayed
   * green. What it does catch is the staleness hardcoding causes: with literals
   * in place, moving `MEMORY_INDEX_READ_LIMIT_BYTES` fails this test. The read
   * limit is the one input expected to move, so that is most of the value, but
   * the guarantee is "a stale literal fails the next time the limit moves", not
   * "a literal cannot be written here".
   */
  it("keeps the budget and the warning line consistent with the read limit", () => {
    expect(MEMORY_INDEX_BUDGET_BYTES).toBe(
      Math.floor(MEMORY_INDEX_READ_LIMIT_BYTES * MEMORY_INDEX_BUDGET_FRACTION),
    );
    expect(MEMORY_INDEX_WARN_BYTES).toBe(
      Math.floor(MEMORY_INDEX_BUDGET_BYTES * MEMORY_INDEX_WARN_FRACTION),
    );
    // A budget at or above the limit would gate nothing; a warning at or above
    // the budget would never fire before the failure it is meant to precede.
    expect(MEMORY_INDEX_BUDGET_BYTES).toBeLessThan(MEMORY_INDEX_READ_LIMIT_BYTES);
    expect(MEMORY_INDEX_WARN_BYTES).toBeLessThan(MEMORY_INDEX_BUDGET_BYTES);
  });

  it("counts bytes, not characters — the index is full of em dashes", () => {
    expect(utf8Bytes("—")).toBe(3);
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes(null)).toBe(0);
  });
});

describe("parseMemoryPointers (Issue #1206)", () => {
  it("captures the link target so a pointer can be resolved against disk", () => {
    const { pointers, malformed } = parseMemoryPointers(
      "- [A Title](file_a.md) — hook\n- [B](sub_b.md) — other\n",
    );
    expect(malformed).toEqual([]);
    expect(pointers.map((entry) => entry.file)).toEqual(["file_a.md", "sub_b.md"]);
    expect(pointers[0]).toMatchObject({ lineNumber: 1, title: "A Title" });
  });

  it("reports a bullet that is not a pointer instead of skipping it", () => {
    // Skipping would exempt it from BOTH the pointer rule and the per-entry cap,
    // leaving one unbounded line able to spend the whole budget.
    const { pointers, malformed } = parseMemoryPointers("- just prose, no link\n");
    expect(pointers).toEqual([]);
    expect(malformed).toEqual([{ lineNumber: 1, line: "- just prose, no link", bytes: 21 }]);
  });

  it("ignores headings, blanks and prose that are not bullets", () => {
    const { pointers, malformed } = parseMemoryPointers("# Index\n\nSome prose.\n");
    expect(pointers).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it("returns empty for a non-string, without throwing", () => {
    expect(parseMemoryPointers(null)).toEqual({ pointers: [], malformed: [] });
  });
});

describe("checkMemoryIndex (Issue #1206)", () => {
  /** @param {number} bytes @param {string} file */
  function entryOfSize(bytes, file = "f.md") {
    const prefix = `- [T](${file}) — `;
    return prefix + "x".repeat(Math.max(0, bytes - utf8Bytes(prefix)));
  }

  // --- the fail-open arms, proven explicitly --------------------------------

  it("PASSES an absent store — the harness creates the directory regardless (#1163)", () => {
    const report = checkMemoryIndex({ store: "code-review" });
    expect(report).toEqual({ problems: [], warnings: [] });
  });

  it("PASSES an empty store directory: no index, no files, no archive", () => {
    const report = checkMemoryIndex({
      store: "code-review",
      indexPresent: false,
      index: null,
      archive: null,
      files: [],
    });
    expect(report.problems).toEqual([]);
  });

  it("FAILS an index that is present but unreadable — not 'zero bytes, under budget'", () => {
    const report = checkMemoryIndex({ store: "code-issue", indexPresent: true, index: null });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("could not be read");
    expect(report.problems[0]).not.toContain("budget)");
  });

  it("FAILS memory files present with no index at all", () => {
    const report = checkMemoryIndex({ store: "code-issue", files: ["a.md", "b.md"] });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain(`holds 2 memory file(s) but no ${MEMORY_INDEX_FILE}`);
  });

  it("elides the file list past five rather than printing a whole store", () => {
    const files = Array.from({ length: 9 }, (_, i) => `m${i}.md`);
    const report = checkMemoryIndex({ store: "code-issue", files });
    expect(report.problems[0]).toContain("holds 9 memory file(s)");
    expect(report.problems[0]).toContain("m4.md, …");
    expect(report.problems[0]).not.toContain("m5.md");
  });

  it("treats a non-array `files` as no files rather than throwing", () => {
    // The runner always passes an array; a caller that does not must degrade to
    // the empty-store arm, not crash the whole gate mid-run.
    expect(checkMemoryIndex({ store: "s", files: null })).toEqual({ problems: [], warnings: [] });
  });

  it("FAILS a zero-byte index while files sit unindexed on disk", () => {
    // Size alone says "well under budget". Pointer resolution is what catches it.
    const report = checkMemoryIndex({
      store: "code-issue",
      indexPresent: true,
      index: "",
      files: ["orphan.md"],
    });
    expect(report.problems.some((p) => p.includes("orphan.md"))).toBe(true);
  });

  // --- budget ----------------------------------------------------------------

  it("FAILS over budget, naming the store, the size and the budget", () => {
    const index = `${entryOfSize(100)}\n`.repeat(400);
    const report = checkMemoryIndex({
      store: "code-issue",
      indexPresent: true,
      index,
      files: ["f.md"],
    });
    const breach = report.problems.find((p) => p.includes("over the"));
    expect(breach).toContain(`${MEMORY_DIR}/code-issue/${MEMORY_INDEX_FILE}`);
    expect(breach).toContain(`${utf8Bytes(index)} bytes`);
    expect(breach).toContain(`${MEMORY_INDEX_BUDGET_BYTES}-byte budget`);
    expect(breach).toContain(MEMORY_ARCHIVE_FILE);
  });

  it("PASSES exactly at the budget and FAILS one byte over", () => {
    const at = "x".repeat(MEMORY_INDEX_BUDGET_BYTES - 1) + "\n";
    const over = `${at}x`;
    // The arms differ by exactly one byte and nothing else — asserted over the
    // two inputs actually passed to the checks below, not over an unrelated
    // local (an assertion that does not name a value under test proves nothing).
    expect(utf8Bytes(at)).toBe(MEMORY_INDEX_BUDGET_BYTES);
    expect(utf8Bytes(over)).toBe(MEMORY_INDEX_BUDGET_BYTES + 1);
    expect(over.startsWith(at)).toBe(true);

    const input = { store: "s", indexPresent: true, files: [], archive: null };
    expect(checkMemoryIndex({ ...input, index: at }).problems).toEqual([]);
    expect(
      checkMemoryIndex({ ...input, index: over }).problems.some((p) => p.includes("over the")),
    ).toBe(true);
  });

  it("WARNS but does not fail on approach", () => {
    const index = "x".repeat(MEMORY_INDEX_WARN_BYTES);
    const report = checkMemoryIndex({ store: "s", indexPresent: true, index, files: [] });
    expect(report.problems).toEqual([]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain(`${MEMORY_INDEX_BUDGET_BYTES}-byte budget`);
  });

  it("is silent one byte below the warning line", () => {
    const index = "x".repeat(MEMORY_INDEX_WARN_BYTES - 1);
    const report = checkMemoryIndex({ store: "s", indexPresent: true, index, files: [] });
    expect(report).toEqual({ problems: [], warnings: [] });
  });

  // --- per-entry cap ---------------------------------------------------------

  it("PASSES an entry exactly at the cap and FAILS it one byte longer", () => {
    const at = entryOfSize(MEMORY_ENTRY_MAX_BYTES);
    expect(utf8Bytes(at)).toBe(MEMORY_ENTRY_MAX_BYTES);
    expect(
      checkMemoryIndex({ store: "s", indexPresent: true, index: at, files: ["f.md"] }).problems,
    ).toEqual([]);

    const over = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: `${at}x`,
      files: ["f.md"],
    });
    expect(over.problems).toHaveLength(1);
    expect(over.problems[0]).toContain(":1 is 151 bytes");
    expect(over.problems[0]).toContain(`${MEMORY_ENTRY_MAX_BYTES}-byte per-entry cap`);
    expect(over.problems[0]).toContain("f.md");
  });

  it("measures the cap in bytes, so a multi-byte hook cannot slip under it", () => {
    // 60 em dashes = 180 bytes but only 60 characters. A character-counting cap
    // would pass this and let the budget it protects overrun anyway.
    const index = `- [T](f.md) ${"—".repeat(60)}`;
    expect(index.length).toBeLessThan(MEMORY_ENTRY_MAX_BYTES);
    const report = checkMemoryIndex({ store: "s", indexPresent: true, index, files: ["f.md"] });
    expect(report.problems.some((p) => p.includes("per-entry cap"))).toBe(true);
  });

  it("FAILS a bullet that is not a pointer, so the cap cannot be bypassed", () => {
    const index = `- ${"x".repeat(400)}`;
    const report = checkMemoryIndex({ store: "s", indexPresent: true, index, files: [] });
    expect(report.problems.some((p) => p.includes("is a bullet but not a pointer"))).toBe(true);
  });

  // --- both directions -------------------------------------------------------

  it("FAILS a pointer that names a file which is not on disk", () => {
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: "- [Gone](vanished.md) — hook",
      files: [],
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('points at "vanished.md"');
  });

  it("FAILS a file on disk that neither the index nor the archive names", () => {
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: "- [Kept](kept.md) — hook",
      files: ["kept.md", "orphan.md"],
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("orphan.md");
    expect(report.problems[0]).toContain(MEMORY_ARCHIVE_FILE);
  });

  it("PASSES a file whose pointer moved to the archive — retired, not deleted", () => {
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: "- [Kept](kept.md) — hook",
      archive: "- [Retired](old.md) — superseded by kept.md",
      files: ["kept.md", "old.md"],
    });
    expect(report).toEqual({ problems: [], warnings: [] });
  });

  it("does not charge the archive against the budget or the entry cap", () => {
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: "- [Kept](kept.md) — hook",
      archive: `${entryOfSize(400, "old.md")}\n`.repeat(200),
      files: ["kept.md", "old.md"],
    });
    expect(report).toEqual({ problems: [], warnings: [] });
  });

  // --- one predicate, both sides ---------------------------------------------

  it("resolves a pointer one directory down, rather than calling it missing", () => {
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: "- [Deep](nested/deep.md) — hook",
      files: ["nested/deep.md"],
    });
    expect(report).toEqual({ problems: [], warnings: [] });
  });

  it("normalises a backslash-separated pointer to the runner's posix answer", () => {
    // The disk side always emits `/`. If the two sides disagreed on the
    // separator, a Windows-authored pointer would read as both dangling and
    // unreachable at once — two messages for a file that is simply there.
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: "- [Deep](nested\\deep.md) — hook",
      files: ["nested/deep.md"],
    });
    expect(report).toEqual({ problems: [], warnings: [] });
  });

  it("FAILS a pointer that is not a memory entry, with its own message", () => {
    // "not a memory entry" and "does not exist" are different faults, and
    // reporting the second for the first sends the reader hunting for a file
    // that was never named.
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: "- [Up](../elsewhere/x.md) — hook",
      files: [],
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("is not a memory entry");
    expect(report.problems[0]).not.toContain("does not exist");
  });

  it("FAILS a pointer at the index or the archive itself", () => {
    for (const target of [MEMORY_INDEX_FILE, MEMORY_ARCHIVE_FILE]) {
      const report = checkMemoryIndex({
        store: "s",
        indexPresent: true,
        index: `- [Self](${target}) — hook`,
        files: [],
      });
      expect(report.problems.some((p) => p.includes("is not a memory entry"))).toBe(true);
    }
  });

  it("FAILS the same pointer listed twice — the budget pays for it twice", () => {
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: "- [A](a.md) — hook\n- [A again](a.md) — hook",
      files: ["a.md"],
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('lists "a.md" a second time');
  });

  it("FAILS a pointer named by BOTH the index and the archive — that is not retired", () => {
    // An entry in both looks retired while still being loaded, so "I archived
    // it" would stop meaning "it left the index".
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: "- [Kept](kept.md) — hook",
      archive: "- [Kept](kept.md) — supposedly retired",
      files: ["kept.md"],
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("has retired it");
  });

  it("names a horizontal rule as one, rather than calling it a bullet", () => {
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: "- [A](a.md) — hook\n---\n",
      files: ["a.md"],
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("is a markdown horizontal rule");
    expect(report.problems[0]).not.toContain("is a bullet but not a pointer");
  });

  it("tells a nested sub-bullet author that nesting is what is wrong", () => {
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: true,
      index: "- [A](a.md) — hook\n  - extra detail\n",
      files: ["a.md"],
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("an indented sub-bullet is a bullet too");
  });

  it("FAILS an archive with no index and no files — the pointers resolve to nothing", () => {
    const report = checkMemoryIndex({
      store: "s",
      indexPresent: false,
      archive: "- [Retired](old.md) — gone",
      files: [],
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain(`no ${MEMORY_INDEX_FILE}`);
  });
});

describe("checkMemoryStoresGathered (Issue #1206)", () => {
  it("FAILS when git knows an index the disk walk never gathered", () => {
    const problems = checkMemoryStoresGathered({
      memoryIndexes: ["code-issue"],
      memoryStores: [],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${MEMORY_DIR}/code-issue/${MEMORY_INDEX_FILE}`);
    expect(problems[0]).toContain("did not run");
  });

  it("passes when the two sources agree", () => {
    expect(
      checkMemoryStoresGathered({
        memoryIndexes: ["code-issue"],
        memoryStores: [{ store: "code-issue" }],
      }),
    ).toEqual([]);
  });

  it("allows a store on disk that git does not track yet — that is a store being created", () => {
    expect(
      checkMemoryStoresGathered({ memoryIndexes: [], memoryStores: [{ store: "brand-new" }] }),
    ).toEqual([]);
  });

  it("tolerates non-array inputs without throwing", () => {
    expect(checkMemoryStoresGathered({})).toEqual([]);
    expect(checkMemoryStoresGathered({ memoryIndexes: null, memoryStores: null })).toEqual([]);
  });
});

describe("checkMemoryIndexes (Issue #1206)", () => {
  it("aggregates every store and reports them in a stable order", () => {
    const report = checkMemoryIndexes([
      { store: "zulu", indexPresent: true, index: "- [A](a.md) — x", files: [] },
      { store: "alpha", indexPresent: true, index: "- [B](b.md) — x", files: [] },
    ]);
    expect(report.problems).toHaveLength(2);
    expect(report.problems[0]).toContain("alpha");
    expect(report.problems[1]).toContain("zulu");
  });

  it("returns empty for a non-array rather than throwing", () => {
    expect(checkMemoryIndexes(undefined)).toEqual({ problems: [], warnings: [] });
  });
});

describe("verifyAgents wires the memory budget rules (Issue #1206)", () => {
  // Same reasoning as the durable-finding wiring test above: deleting the call
  // from `verifyAgents` leaves every direct test green.
  const claudeMd = "| `code-review` | Review |";

  it("fails end to end on an over-budget store", () => {
    const report = verifyAgents({
      agentFiles: { "code-review": agentFile() },
      claudeMd,
      memoryStores: [
        {
          store: "code-issue",
          indexPresent: true,
          index: "x".repeat(MEMORY_INDEX_BUDGET_BYTES + 1),
          files: [],
        },
      ],
    });
    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.includes(`${MEMORY_INDEX_BUDGET_BYTES}-byte budget`)),
    ).toBe(true);
  });

  it("surfaces the approach warning without failing", () => {
    const report = verifyAgents({
      agentFiles: { "code-review": agentFile() },
      claudeMd,
      memoryStores: [
        {
          store: "code-issue",
          indexPresent: true,
          index: "x".repeat(MEMORY_INDEX_WARN_BYTES),
          files: [],
        },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.warnings.some((w) => w.includes("under the"))).toBe(true);
  });

  it("fails end to end when git tracks an index that was never gathered", () => {
    const report = verifyAgents({
      agentFiles: { "code-review": agentFile() },
      claudeMd,
      memoryIndexes: ["code-issue"],
      memoryStores: [],
    });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes("did not run"))).toBe(true);
  });
});

describe("isMcpToolName (Issue #1180)", () => {
  it("recognises both the wildcard allowlist and a concrete tool name", () => {
    expect(isMcpToolName("mcp__github__*")).toBe(true);
    expect(isMcpToolName("mcp__playwright__browser_click")).toBe(true);
    expect(isMcpToolName("mcp_github_issue_read")).toBe(true);
    expect(isMcpToolName("mcp__*")).toBe(true);
  });

  it("does not fire on ordinary tools or on near-miss spellings", () => {
    for (const entry of ["Read", "Bash", "Agent(Explore, Plan)", "mcpServers", ".mcp.json", ""]) {
      expect(isMcpToolName(entry)).toBe(false);
    }
    expect(isMcpToolName(undefined)).toBe(false);
  });
});

describe("hasMcpTools (Issue #1180)", () => {
  it("treats an absent allowlist as holding every tool, MCP included", () => {
    expect(hasMcpTools([], false)).toBe(true);
  });

  it("treats an allowlist naming no mcp pattern as holding none", () => {
    expect(hasMcpTools(["Read", "Bash", "Skill"], true)).toBe(false);
  });

  it("treats an allowlist naming an mcp pattern as holding some", () => {
    expect(hasMcpTools(["Read", "mcp__github__*"], true)).toBe(true);
  });

  it("treats a present-but-empty allowlist as holding none", () => {
    expect(hasMcpTools([], true)).toBe(false);
  });

  /**
   * The allowlist and prose readings of the token must diverge on exactly this one
   * form: `tools: mcp__*` is the broadest grant there is, while `mcp__*` in a skill
   * body is the string you write to *explain* the rule. Collapsing them back into one
   * pattern would either force a marker onto explanatory prose or, far worse, read a
   * blanket MCP grant as "no MCP tools".
   */
  it("keeps reading a BARE mcp__* allowlist entry as a grant", () => {
    expect(isMcpToolName("mcp__*")).toBe(true);
    expect(hasMcpTools(["Read", "mcp__*"], true)).toBe(true);
    expect(findMcpInstructions("Declare `mcp__*` to hold them.")).toEqual([]);
  });
});

describe("findMcpInstructions (Issue #1180)", () => {
  it("reports the token and its 1-based line number in the whole file", () => {
    const skill = [
      "---",
      "name: code-review",
      "---",
      "",
      "1. Read the PR using `mcp_github_pull_request_read`.",
    ].join("\n");
    expect(findMcpInstructions(skill)).toEqual([
      {
        line: 5,
        token: "mcp_github_pull_request_read",
        text: "1. Read the PR using `mcp_github_pull_request_read`.",
      },
    ]);
  });

  it("ignores prose that merely mentions MCP without naming a tool", () => {
    const skill = [
      "---",
      "name: clean",
      "---",
      "MCP servers live in `.mcp.json`, and `mcpServers:` lists them.",
      "The GitHub MCP server is optional.",
    ].join("\n");
    expect(findMcpInstructions(skill)).toEqual([]);
  });

  it("does not scan the frontmatter — a description is prose about the skill", () => {
    const skill = [
      "---",
      "name: x",
      "description: uses mcp_github_issue_read",
      "---",
      "Use gh.",
    ].join("\n");
    expect(findMcpInstructions(skill)).toEqual([]);
  });

  it("exempts a line carrying the main-session marker", () => {
    const skill = [
      "---",
      "name: code-review",
      "---",
      `The main session may use \`mcp__github__create_pull_request_review\`. ${MCP_MAIN_SESSION_MARKER}`,
    ].join("\n");
    expect(findMcpInstructions(skill)).toEqual([]);
  });

  it("still reports an unmarked line when a neighbouring line is marked", () => {
    const skill = [
      "---",
      "name: code-review",
      "---",
      `Main session only: \`mcp__github__get_me\`. ${MCP_MAIN_SESSION_MARKER}`,
      "Then call `mcp_github_issue_write`.",
    ].join("\n");
    const hits = findMcpInstructions(skill);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(5);
  });

  it("returns nothing for a non-string or an unterminated frontmatter block", () => {
    expect(findMcpInstructions(undefined)).toEqual([]);
    expect(findMcpInstructions(["---", "name: x", "mcp_github_issue_read"].join("\n"))).toEqual([]);
  });

  it("does not fire on the bare wildcard, so a skill can state the rule unmarked", () => {
    const skill = [
      "---",
      "name: code-issue",
      "---",
      "This agent's `tools:` names no `mcp__*` pattern, so it holds no MCP tools.",
      "Any agent declaring an `mcp__*` pattern may use the MCP equivalents.",
    ].join("\n");
    expect(findMcpInstructions(skill)).toEqual([]);
  });

  it("still fires on a wildcard qualified by a server name", () => {
    const hits = findMcpInstructions(
      ["---", "name: x", "---", "Dispatch e2e-test, which holds `mcp__playwright__*`."].join("\n"),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toBe("mcp__playwright__*");
  });

  it("scans a file with no frontmatter at all", () => {
    expect(findMcpInstructions("Call `mcp_github_issue_read` first.")).toEqual([
      {
        line: 1,
        token: "mcp_github_issue_read",
        text: "Call `mcp_github_issue_read` first.",
      },
    ]);
  });
});

describe("checkSkillMcpReachability (Issue #1180)", () => {
  const MCP_SKILL = [
    "---",
    "name: code-review",
    "---",
    "Publish with `mcp_github_pull_request_review_write`.",
  ].join("\n");
  const GH_SKILL = ["---", "name: code-review", "---", "Publish with `gh api`."].join("\n");

  it("fails a no-MCP agent that invokes an MCP-instructing skill", () => {
    const problems = checkSkillMcpReachability({
      name: "code-review",
      hasMcp: false,
      skillReferences: ["code-review"],
      skillFiles: { "code-review": MCP_SKILL },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("code-review");
    expect(problems[0]).toContain("/code-review");
    expect(problems[0]).toContain("mcp_github_pull_request_review_write");
    expect(problems[0]).toContain(`${SKILL_SOURCE_DIR}/code-review/SKILL.md:4`);
    expect(problems[0]).toContain("#1180");
  });

  it("passes the same pairing when the agent declares an mcp pattern", () => {
    expect(
      checkSkillMcpReachability({
        name: "e2e-test",
        hasMcp: true,
        skillReferences: ["code-review"],
        skillFiles: { "code-review": MCP_SKILL },
      }),
    ).toEqual([]);
  });

  it("passes a no-MCP agent whose skill instructs gh", () => {
    expect(
      checkSkillMcpReachability({
        name: "code-review",
        hasMcp: false,
        skillReferences: ["code-review"],
        skillFiles: { "code-review": GH_SKILL },
      }),
    ).toEqual([]);
  });

  it("stays silent about a skill it has no text for — the marked-skill rule owns that", () => {
    expect(
      checkSkillMcpReachability({
        name: "code-review",
        hasMcp: false,
        skillReferences: ["ghost"],
        skillFiles: { "code-review": MCP_SKILL },
      }),
    ).toEqual([]);
  });

  it("reports one problem per offending skill", () => {
    const problems = checkSkillMcpReachability({
      name: "code-planner",
      hasMcp: false,
      skillReferences: ["code-review", "epic-planner"],
      skillFiles: { "code-review": MCP_SKILL, "epic-planner": MCP_SKILL },
    });
    expect(problems).toHaveLength(2);
  });

  it("counts every offending line so a one-line fix cannot look like the whole job", () => {
    const many = [
      "---",
      "name: x",
      "---",
      "`mcp_github_issue_read`",
      "`mcp_github_issue_write`",
    ].join("\n");
    const problems = checkSkillMcpReachability({
      name: "code-review",
      hasMcp: false,
      skillReferences: ["x"],
      skillFiles: { x: many },
    });
    expect(problems[0]).toContain("2 offending line(s)");
  });

  it("defaults its inputs rather than throwing", () => {
    expect(checkSkillMcpReachability({ name: "a", hasMcp: false })).toEqual([]);
  });

  it("follows a skill -> skill handoff the agent body never names", () => {
    const problems = checkSkillMcpReachability({
      name: "code-review",
      hasMcp: false,
      skillReferences: ["code-review"],
      skillFiles: {
        "code-review": [
          "---",
          "name: code-review",
          "---",
          "Publish with `gh api`. Then invoke the `/resolve-pr-comments` skill.",
        ].join("\n"),
        "resolve-pr-comments": MCP_SKILL,
      },
      knownSkillNames: ["code-review", "resolve-pr-comments"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the body says to invoke "/code-review"');
    expect(problems[0]).toContain('hands off to "/resolve-pr-comments"');
    expect(problems[0]).toContain(`${SKILL_SOURCE_DIR}/resolve-pr-comments/SKILL.md:4`);
  });

  it("passes when the handed-off skill is clean, so the hop is not itself the failure", () => {
    expect(
      checkSkillMcpReachability({
        name: "code-review",
        hasMcp: false,
        skillReferences: ["code-review"],
        skillFiles: {
          "code-review": [
            "---",
            "name: code-review",
            "---",
            "Then invoke the `/resolve-pr-comments` skill.",
          ].join("\n"),
          "resolve-pr-comments": GH_SKILL,
        },
        knownSkillNames: ["code-review", "resolve-pr-comments"],
      }),
    ).toEqual([]);
  });
});

describe("resolveSkillClosure (Issue #1180)", () => {
  /** @param {string} name @param {string} body */
  const skill = (name, body) => ["---", `name: ${name}`, "---", body].join("\n");

  it("returns each direct reference as a one-element path", () => {
    const closure = resolveSkillClosure(["a"], { a: skill("a", "Use gh.") });
    expect([...closure.entries()]).toEqual([["a", ["a"]]]);
  });

  it("records the chain that reaches an indirectly-referenced skill", () => {
    const closure = resolveSkillClosure(
      ["a"],
      {
        a: skill("a", "Then invoke the `/b` skill."),
        b: skill("b", "Then invoke the `/c` skill."),
        c: skill("c", "Done."),
      },
      ["a", "b", "c"],
    );
    expect(closure.get("c")).toEqual(["a", "b", "c"]);
  });

  it("terminates on a cycle and on the self-reference every skill body has", () => {
    const closure = resolveSkillClosure(
      ["a"],
      {
        a: skill("a", "See the `/a` skill and the `/b` skill."),
        b: skill("b", "Go back to the `/a` skill."),
      },
      ["a", "b"],
    );
    expect([...closure.keys()].sort()).toEqual(["a", "b"]);
    expect(closure.get("a")).toEqual(["a"]);
  });

  it("keeps the SHORTEST path when a skill is reachable two ways", () => {
    const closure = resolveSkillClosure(
      ["a", "b"],
      {
        a: skill("a", "Then invoke the `/b` skill."),
        b: skill("b", "Done."),
      },
      ["a", "b"],
    );
    expect(closure.get("b")).toEqual(["b"]);
  });

  it("stops at a skill it has no text for without throwing", () => {
    const closure = resolveSkillClosure(["ghost"], {});
    expect([...closure.keys()]).toEqual(["ghost"]);
  });

  it("seeds a repeated direct reference once", () => {
    const closure = resolveSkillClosure(["a", "a"], { a: skill("a", "Use gh.") });
    expect([...closure.entries()]).toEqual([["a", ["a"]]]);
  });

  it("resolves handoffs from skillFiles keys alone when no name list is given", () => {
    const closure = resolveSkillClosure(["a"], {
      a: skill("a", "Then invoke the b skill."),
      b: skill("b", "Done."),
    });
    expect(closure.get("b")).toEqual(["a", "b"]);
  });
});

describe("checkAgent wires the MCP-reachability rule (Issue #1180)", () => {
  const MCP_SKILL = ["---", "name: code-review", "---", "Use `mcp_github_pull_request_read`."].join(
    "\n",
  );

  it("fails an agent told to invoke a skill that instructs an unreachable MCP tool", () => {
    const { problems } = checkAgent({
      name: "code-review",
      text: agentFile({ tools: "Read, Bash, Skill" }, "Invoke the `/code-review` skill."),
      skillNames: KNOWN_SKILLS,
      skillFiles: { "code-review": MCP_SKILL },
    });
    expect(problems.some((problem) => problem.includes("mcp_github_pull_request_read"))).toBe(true);
  });

  it("passes once the agent declares an mcp allowlist pattern", () => {
    const { problems } = checkAgent({
      name: "code-review",
      text: agentFile(
        { tools: "Read, Bash, Skill, mcp__github__*" },
        "Invoke the `/code-review` skill.",
      ),
      skillNames: KNOWN_SKILLS,
      skillFiles: { "code-review": MCP_SKILL },
    });
    expect(problems.some((problem) => problem.includes("mcp_github_pull_request_read"))).toBe(
      false,
    );
  });

  it("passes when no skillFiles are supplied at all", () => {
    const { problems } = checkAgent({
      name: "code-review",
      text: agentFile({ tools: "Read, Bash, Skill" }, "Invoke the `/code-review` skill."),
      skillNames: KNOWN_SKILLS,
    });
    expect(problems).toEqual([]);
  });
});

describe("verifyAgents threads skillFiles through (Issue #1180)", () => {
  it("surfaces the transitive MCP problem from the top-level entry point", () => {
    const report = verifyAgents({
      agentFiles: {
        "code-review": agentFile(
          { name: "code-review", tools: "Read, Bash, Skill" },
          "Invoke the `/code-review` skill.",
        ),
      },
      skillNames: ["code-review"],
      skillFiles: {
        "code-review": ["---", "name: code-review", "---", "Use `mcp_github_issue_read`."].join(
          "\n",
        ),
      },
      claudeMd: "| `code-review` | Review PRs |",
    });
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.includes("mcp_github_issue_read"))).toBe(true);
  });
});

/**
 * `checkSkillMcpReachability` on a skill that exists and whose body cannot be read
 * (Issue #1215). The runner arms in `verify-agent-frontmatter-runner.test.mjs` prove the
 * end-to-end behaviour by spawning the real script; these pin the branch itself, and in
 * particular the line between the two states that used to be one `continue`.
 */
describe("checkSkillMcpReachability: an unreadable body is not a clean one (#1215)", () => {
  it("reports a skill whose body is present-as-a-key but null", () => {
    const problems = checkSkillMcpReachability({
      name: "probe",
      hasMcp: false,
      skillReferences: ["code-review"],
      // The runner writes one key per DISCOVERED skill, with null when the read failed.
      skillFiles: { "code-review": null },
      knownSkillNames: ["code-review"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("could not be read");
    expect(problems[0]).toContain(".github/skills/code-review/SKILL.md");
  });

  it("names the handoff path when the unreadable skill is reached indirectly", () => {
    const problems = checkSkillMcpReachability({
      name: "probe",
      hasMcp: false,
      skillReferences: ["code-review"],
      skillFiles: {
        "code-review": "Hand off to the `/resolve-pr-comments` skill.",
        "resolve-pr-comments": null,
      },
      knownSkillNames: ["code-review", "resolve-pr-comments"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("reached via");
    expect(problems[0]).toContain('"/code-review" -> "/resolve-pr-comments"');
  });

  it("stays silent for a name that is not a skill — the marked-skill rule owns that", () => {
    expect(
      checkSkillMcpReachability({
        name: "probe",
        hasMcp: false,
        skillReferences: ["ghost-skill"],
        skillFiles: { "code-review": "Body." },
        knownSkillNames: ["code-review"],
      }),
    ).toEqual([]);
  });

  /**
   * The DI seam this fix must not fire on: a caller that supplies no bodies at all.
   * `checkAgent`'s own arms do exactly that, and keying "does this skill exist?" off
   * `knownSkillNames` rather than off the presence of a `skillFiles` key turned that
   * seam into a failure — measured, four pre-existing arms went red.
   */
  it("stays silent when the caller supplies no skillFiles at all", () => {
    expect(
      checkSkillMcpReachability({
        name: "probe",
        hasMcp: false,
        skillReferences: ["code-review"],
        knownSkillNames: ["code-review"],
      }),
    ).toEqual([]);
  });

  it("stays silent when the agent can reach MCP tools anyway", () => {
    expect(
      checkSkillMcpReachability({
        name: "probe",
        hasMcp: true,
        skillReferences: ["code-review"],
        skillFiles: { "code-review": null },
        knownSkillNames: ["code-review"],
      }),
    ).toEqual([]);
  });
});

describe("panel voters must not share one worktree (Issue #1277)", () => {
  /**
   * A body that qualifies as a dispatch site: it names the voter agent and every
   * lens. Built from `LENSES` rather than from three literals so that renaming a
   * lens moves the fixture with the rule instead of leaving it asserting a slug
   * nothing uses (#1190).
   *
   * @param {{ isolated?: boolean, extra?: string }} [options]
   * @returns {string}
   */
  function dispatchBody({ isolated = true, extra = "" } = {}) {
    return [
      "---",
      "name: probe",
      `description: "${GOOD_DESCRIPTION}"`,
      "---",
      "",
      `Dispatch three \`${PANEL_VOTER_AGENT}\` agents in one message, one per lens:`,
      ...LENSES.map((lens) => `- \`${lens}\``),
      isolated ? `Give each \`${WORKTREE_ISOLATION_MARKER}\`.` : "",
      extra,
    ].join("\n");
  }

  describe("findPanelDispatchSites", () => {
    it("finds a site in an agent body and in a SKILL.md, agents first", () => {
      const sites = findPanelDispatchSites({
        agentFiles: { "code-issue": dispatchBody() },
        skillFiles: { "adversarial-review": dispatchBody() },
      });
      expect(sites.map((site) => site.path)).toEqual([
        `${AGENT_DIR}/code-issue.md`,
        `${SKILL_SOURCE_DIR}/adversarial-review/SKILL.md`,
      ]);
    });

    it("excludes the voter's own definition, which names every lens by construction", () => {
      // It is briefed on all three because it IS all three; it is the agent being
      // dispatched, not a place anyone reads to learn how to dispatch it.
      expect(
        findPanelDispatchSites({ agentFiles: { [PANEL_VOTER_AGENT]: dispatchBody() } }),
      ).toEqual([]);
    });

    it("needs EVERY lens, not merely one", () => {
      const partial = [
        "---",
        "name: probe",
        `description: "${GOOD_DESCRIPTION}"`,
        "---",
        "",
        `Dispatch \`${PANEL_VOTER_AGENT}\` on \`${LENSES[0]}\` only.`,
      ].join("\n");
      expect(findPanelDispatchSites({ agentFiles: { probe: partial } })).toEqual([]);
    });

    it("needs the voter agent named, so a lens glossary is not a dispatch site", () => {
      const glossary = ["---", "name: probe", "---", "", ...LENSES].join("\n");
      expect(findPanelDispatchSites({ agentFiles: { probe: glossary } })).toEqual([]);
    });

    it("reads the body only — a description naming the panel is prose about it", () => {
      const inFrontmatter = [
        "---",
        "name: probe",
        `description: "Dispatches ${PANEL_VOTER_AGENT} on ${LENSES.join(", ")}."`,
        "---",
        "",
        "Body says nothing.",
      ].join("\n");
      expect(findPanelDispatchSites({ agentFiles: { probe: inFrontmatter } })).toEqual([]);
    });

    it("skips an unreadable body instead of throwing", () => {
      expect(
        findPanelDispatchSites({ agentFiles: { probe: null }, skillFiles: { other: null } }),
      ).toEqual([]);
    });

    it("treats an empty lens list as 'no panel', not as 'every file qualifies'", () => {
      // `[].every(...)` is true, so a naive implementation would classify every
      // file that merely names the agent. A default that silently WIDENS is the
      // mirror of one that silently empties (#1215).
      expect(findPanelDispatchSites({ agentFiles: { probe: dispatchBody() }, lenses: [] })).toEqual(
        [],
      );
    });
  });

  describe("checkPanelWorktreeIsolation", () => {
    it("passes when every dispatch site names the marker", () => {
      expect(
        checkPanelWorktreeIsolation({
          agentFiles: { [PANEL_VOTER_AGENT]: "---\nname: x\n---\n", "code-issue": dispatchBody() },
          skillFiles: { "adversarial-review": dispatchBody() },
        }),
      ).toEqual([]);
    });

    it("fails the site that lost the marker, and names only that one", () => {
      const problems = checkPanelWorktreeIsolation({
        agentFiles: {
          [PANEL_VOTER_AGENT]: "---\nname: x\n---\n",
          "code-issue": dispatchBody({ isolated: false }),
        },
        skillFiles: { "adversarial-review": dispatchBody() },
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${AGENT_DIR}/code-issue.md`);
      expect(problems[0]).toContain(WORKTREE_ISOLATION_MARKER);
      expect(problems[0]).not.toContain("adversarial-review/SKILL.md");
    });

    // The marker is the literal the Agent tool accepts. A near-miss does not
    // isolate anything, so accepting one would bless a dispatch that still shares
    // a tree — the failure direction that costs something.
    it.each([
      ["unquoted", "Give each isolation: worktree."],
      ["single-quoted", "Give each isolation: 'worktree'."],
      ["prose only", "Give each its own worktree somehow."],
    ])("does not accept a near-miss (%s)", (_label, wording) => {
      const problems = checkPanelWorktreeIsolation({
        agentFiles: {
          [PANEL_VOTER_AGENT]: "---\nname: x\n---\n",
          probe: dispatchBody({ isolated: false, extra: wording }),
        },
      });
      expect(problems).toHaveLength(1);
    });

    it("fails when the voter exists but nothing tells anyone to dispatch it", () => {
      // A rule with no subject reads exactly like a rule that passed (#1215).
      const problems = checkPanelWorktreeIsolation({
        agentFiles: { [PANEL_VOTER_AGENT]: "---\nname: x\n---\n", "code-issue": "No panel here." },
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${AGENT_DIR}/${PANEL_VOTER_AGENT}.md`);
      expect(problems[0]).toContain("no agent body or SKILL.md names both");
    });

    it("fails when the sites dispatch a voter agent that does not exist", () => {
      const problems = checkPanelWorktreeIsolation({
        skillFiles: { "adversarial-review": dispatchBody() },
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("does not exist");
    });

    it("is inert in a repository with no panel at all", () => {
      // The runner's throwaway fixture is exactly this shape. The hole it leaves —
      // deleting the voter agent AND every site together — is closed elsewhere:
      // checkClaudeMdTable pins the agent set to CLAUDE.md's table.
      expect(
        checkPanelWorktreeIsolation({
          agentFiles: { probe: "---\nname: probe\n---\n\nUnrelated." },
          skillFiles: { other: "---\nname: other\n---\n\nUnrelated." },
        }),
      ).toEqual([]);
    });
  });

  describe("verifyAgents wires the rule", () => {
    // Without this, deleting the `checkPanelWorktreeIsolation` call from
    // `verifyAgents` leaves every direct test above green (#1168's lesson).
    it("reports an un-isolated dispatch site through the top-level entry point", () => {
      const report = verifyAgents({
        agentFiles: {
          [PANEL_VOTER_AGENT]: agentFile({ name: PANEL_VOTER_AGENT }),
          probe: dispatchBody({ isolated: false }),
        },
        claudeMd: `| \`${PANEL_VOTER_AGENT}\` | v |\n| \`probe\` | p |`,
      });
      expect(report.ok).toBe(false);
      expect(report.problems.some((p) => p.includes(WORKTREE_ISOLATION_MARKER))).toBe(true);
    });
  });

  describe("the real repository", () => {
    const repoRoot = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");

    /**
     * @param {string} relativePath
     * @returns {string | null}
     */
    function readOrNull(relativePath) {
      try {
        return fs.readFileSync(path.join(repoRoot, ...relativePath.split("/")), "utf8");
      } catch {
        return null;
      }
    }

    /** @returns {{ agentFiles: Record<string, string | null>, skillFiles: Record<string, string | null> }} */
    function readRepo() {
      /** @type {Record<string, string | null>} */
      const agentFiles = {};
      for (const entry of fs.readdirSync(path.join(repoRoot, ...AGENT_DIR.split("/")))) {
        if (entry.endsWith(".md"))
          agentFiles[entry.slice(0, -3)] = readOrNull(`${AGENT_DIR}/${entry}`);
      }
      /** @type {Record<string, string | null>} */
      const skillFiles = {};
      for (const entry of fs.readdirSync(path.join(repoRoot, ...SKILL_SOURCE_DIR.split("/")))) {
        skillFiles[entry] = readOrNull(`${SKILL_SOURCE_DIR}/${entry}/SKILL.md`);
      }
      return { agentFiles, skillFiles };
    }

    // Pinned as a SET, not a count. The gate itself only notices a site that
    // exists and lacks the marker, or the case where every site is gone; it
    // cannot notice one site of three quietly losing its dispatch instructions,
    // which is the #1187 half-migration in the other direction. Enumerating the
    // expected paths is what makes a deletion visible (#1182, #1194).
    it("has exactly the three dispatch sites this change migrated", () => {
      const sites = findPanelDispatchSites(readRepo()).map((site) => site.path);
      expect(sites).toEqual([
        `${AGENT_DIR}/code-issue.md`,
        `${SKILL_SOURCE_DIR}/adversarial-review/SKILL.md`,
        `${SKILL_SOURCE_DIR}/code-issue/SKILL.md`,
      ]);
    });

    it("isolates the voters at every one of them", () => {
      expect(checkPanelWorktreeIsolation(readRepo())).toEqual([]);
    });

    it("no longer claims the voter is read-only", () => {
      const voter = readOrNull(`${AGENT_DIR}/${PANEL_VOTER_AGENT}.md`) ?? "";
      const { fields } = parseFrontmatter(voter);
      // The description is the only part loaded before a dispatch decision, and
      // "Read-only." was the claim `Bash` defeats (#1277, and the #1162/#1163/
      // #1168/#1180/#1224 class).
      expect(fields.description ?? "").not.toMatch(/read-only/i);
      // The denial itself is NOT relaxed: it still prevents the editing the panel
      // must not do. Only the false capability claim went.
      expect(fields.disallowedTools ?? "").toContain("Write");
      expect(fields.disallowedTools ?? "").toContain("Edit");
    });

    it("tells lenses to measure from a committed blob and to prove dirtiness", () => {
      const voter = readOrNull(`${AGENT_DIR}/${PANEL_VOTER_AGENT}.md`) ?? "";
      // The SHA the dispatch names, NOT `HEAD` — in an isolation worktree HEAD is
      // the baseline, which is what both non-mutating lenses caught on #1277.
      expect(voter).toContain("git show <tip-sha>:");
      expect(voter).toContain("git show <base-sha>:");
      expect(voter).toContain("git status --porcelain");
      // A restore closes the window afterwards, not during — still required.
      expect(voter).toContain("git checkout -- ");
    });
  });
});

describe("panel isolation: one interpretation of the lens list (Issue #1277)", () => {
  // The finder guarded with `Array.isArray` and the checker did not, so a
  // non-array made the finder return no sites and the checker's own "no sites"
  // message then threw on `.join`. Two views of one input is #1192's shape.
  it.each([
    ["a string", "over-blocking"],
    ["null", null],
    ["a number", 3],
    ["an object", { lens: "over-blocking" }],
  ])("does not throw when lenses is %s", (_label, lenses) => {
    expect(() =>
      checkPanelWorktreeIsolation({
        agentFiles: { [PANEL_VOTER_AGENT]: "---\nname: x\n---\n" },
        // @ts-expect-error deliberately the wrong type — that is the case under test
        lenses,
      }),
    ).not.toThrow();
  });

  it("reports zero lenses rather than inventing them, and still fires", () => {
    const problems = checkPanelWorktreeIsolation({
      agentFiles: { [PANEL_VOTER_AGENT]: "---\nname: x\n---\n" },
      lenses: [],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("all 0 lenses ()");
  });

  it("drops a non-string lens instead of matching it against a body", () => {
    // The body names the agent and the one real lens, and contains no "9".
    // WITH the filter the lens list is ["over-blocking"] and this is a site;
    // WITHOUT it, `body.includes(9)` coerces to "9", finds nothing, and the site
    // vanishes. An `agentFiles: {}` fixture would return [] either way — which is
    // what the first version of this test did, and a voter caught it.
    const body = `---\nname: probe\n---\n\nDispatch ${PANEL_VOTER_AGENT} on over-blocking.`;
    expect(body).not.toContain("9");
    const sites = findPanelDispatchSites({
      agentFiles: { probe: body },
      // @ts-expect-error deliberately a mixed array — that is the case under test
      lenses: ["over-blocking", 9],
    });
    expect(sites.map((site) => site.path)).toEqual([`${AGENT_DIR}/probe.md`]);
  });
});

describe("an isolated voter's HEAD is the baseline, not the change (Issue #1277)", () => {
  /** @param {string} extra */
  function isolatedSite(extra) {
    return [
      "---",
      "name: probe",
      `description: "${GOOD_DESCRIPTION}"`,
      "---",
      "",
      `Dispatch \`${PANEL_VOTER_AGENT}\` with \`${WORKTREE_ISOLATION_MARKER}\`, one per lens:`,
      ...LENSES.map((lens) => `- \`${lens}\``),
      extra,
    ].join("\n");
  }

  it("rejects a dispatch site that tells a voter to read a blob at HEAD", () => {
    const problems = checkPanelWorktreeIsolation({
      agentFiles: {
        [PANEL_VOTER_AGENT]: "---\nname: x\n---\n",
        probe: isolatedSite(`Measure with \`${PANEL_HEAD_BLOB_ANTIPATTERN}<path>\`.`),
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("HEAD is the BASELINE");
  });

  it("rejects it in the voter's own definition, which the site rule excludes", () => {
    // That file is where a voter is actually told how to measure, so the one
    // panel document the dispatch-site rule skips is the one that matters most.
    const problems = checkPanelWorktreeIsolation({
      agentFiles: {
        [PANEL_VOTER_AGENT]: `---\nname: ${PANEL_VOTER_AGENT}\n---\n\nTake it from ${PANEL_HEAD_BLOB_ANTIPATTERN}<path>.`,
        probe: isolatedSite(""),
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${AGENT_DIR}/${PANEL_VOTER_AGENT}.md`);
  });

  it("does NOT ban origin/main...HEAD, which the dispatcher runs in its own tree", () => {
    // shouldRunAdversarialPass is computed from `git diff --name-only
    // origin/main...HEAD` by the dispatcher, where HEAD *is* the change. Banning
    // it would be the over-blocking failure this panel keeps a lens for.
    expect(
      checkPanelWorktreeIsolation({
        agentFiles: {
          [PANEL_VOTER_AGENT]: "---\nname: x\n---\n",
          probe: isolatedSite("Compute the gate with `git diff --name-only origin/main...HEAD`."),
        },
      }),
    ).toEqual([]);
  });

  it("accepts the SHA form the fix prescribes", () => {
    expect(
      checkPanelWorktreeIsolation({
        agentFiles: {
          [PANEL_VOTER_AGENT]: "---\nname: x\n---\n",
          probe: isolatedSite("Measure with `git show <tip-sha>:<path>`."),
        },
      }),
    ).toEqual([]);
  });

  it("the real repository names no HEAD blob read in any panel document", () => {
    const repoRoot = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..");
    /** @param {string} rel */
    const read = (rel) => fs.readFileSync(path.join(repoRoot, ...rel.split("/")), "utf8");
    for (const rel of [
      `${AGENT_DIR}/${PANEL_VOTER_AGENT}.md`,
      `${AGENT_DIR}/code-issue.md`,
      `${SKILL_SOURCE_DIR}/adversarial-review/SKILL.md`,
      `${SKILL_SOURCE_DIR}/code-issue/SKILL.md`,
    ]) {
      expect(read(rel), rel).not.toContain(PANEL_HEAD_BLOB_ANTIPATTERN);
    }
  });
});
