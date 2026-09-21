import { describe, expect, it } from "vitest";

import {
  CLAUDE_AGENT_DIR,
  COPILOT_AGENT_DIR,
  COPILOT_AGENT_SUFFIX,
  SURFACE_TOKENS,
  checkCopilotAgent,
  checkRosterParity,
  checkSurfaceDocumented,
  copilotAgentSlug,
  documentClaimsCopilotSurface,
  parseAgentReferences,
  parseSurfaceMarker,
  slugifyAgentName,
  verifyCopilotSurface,
} from "./copilot-agent-surface-core.mjs";

/** A minimally valid Copilot agent body. */
function agent({ name = "Code Review", description = null, extra = "", body = "Do things." }) {
  const desc =
    description ??
    "Meticulous senior code reviewer that validates PRs against requirements and security.";
  return ["---", `name: ${name}`, `description: ${desc}`, "tools:", "  - read", extra, "---", body]
    .filter((line) => line !== "")
    .join("\n");
}

describe("slugifyAgentName", () => {
  it("maps a Copilot display name onto the shared kebab-case identity", () => {
    expect(slugifyAgentName("Adversarial Reviewer")).toBe("adversarial-reviewer");
    expect(slugifyAgentName("E2E Test")).toBe("e2e-test");
    expect(slugifyAgentName("UI Vision")).toBe("ui-vision");
  });

  it("is idempotent on an already-kebab name", () => {
    expect(slugifyAgentName("code-issue")).toBe("code-issue");
  });

  it("returns an empty slug for input with no slug characters", () => {
    expect(slugifyAgentName("  ---  ")).toBe("");
    expect(slugifyAgentName(42)).toBe("");
  });
});

describe("copilotAgentSlug", () => {
  it("accepts only the .agent.md suffix", () => {
    expect(copilotAgentSlug("code-review.agent.md")).toBe("code-review");
    expect(copilotAgentSlug("README.md")).toBeNull();
    expect(copilotAgentSlug(".agent.md")).toBeNull();
    expect(copilotAgentSlug(null)).toBeNull();
  });
});

describe("parseAgentReferences", () => {
  it("reads a block-sequence agents: list", () => {
    const text = agent({ extra: "agents:\n  - Research\n  - Code Issue" });
    expect(parseAgentReferences(text)).toEqual(["Research", "Code Issue"]);
  });

  it("reads an inline flow sequence", () => {
    const text = agent({ extra: "agents: [Research, Code Issue]" });
    expect(parseAgentReferences(text)).toEqual(["Research", "Code Issue"]);
  });

  it("reads agent: keys nested inside handoffs, which parseBlockLists cannot", () => {
    const text = agent({
      extra: [
        "handoffs:",
        "  - label: Start Implementation",
        "    agent: Code Issue",
        "    send: true",
        "  - label: Review Plan",
        "    agent: Code Review",
        "    send: false",
      ].join("\n"),
    });
    expect(parseAgentReferences(text)).toEqual(["Code Issue", "Code Review"]);
  });

  it("deduplicates a name reachable through both agents: and handoffs:", () => {
    const text = agent({
      extra: ["agents:", "  - Code Issue", "handoffs:", "  - agent: Code Issue"].join("\n"),
    });
    expect(parseAgentReferences(text)).toEqual(["Code Issue"]);
  });

  it("stops at the closing fence, so a body mentioning agents: is not a reference", () => {
    const text = `${agent({})}\n\nagents:\n  - Ghost Agent\n`;
    expect(parseAgentReferences(text)).toEqual([]);
  });

  it("returns nothing for a file with no frontmatter", () => {
    expect(parseAgentReferences("no fence here")).toEqual([]);
    expect(parseAgentReferences(null)).toEqual([]);
  });

  it("strips a YAML inline comment from a block-sequence item", () => {
    // An adversarial panel on #1282 demonstrated this: `- Code Issue # the implementer` is
    // valid YAML that Copilot reads as "Code Issue", but was slugifying to
    // "code-issue-the-implementer" and reported as a dangling reference to an agent that
    // exists. A gate rejecting a valid file, blaming the wrong thing.
    const text = agent({ extra: "agents:\n  - Code Issue # the implementer" });
    expect(parseAgentReferences(text)).toEqual(["Code Issue"]);
  });

  it("strips a YAML inline comment from a nested agent: scalar", () => {
    const text = agent({ extra: "handoffs:\n  - label: Go\n    agent: Code Review # then fix" });
    expect(parseAgentReferences(text)).toEqual(["Code Review"]);
  });

  it("keeps a hash inside a QUOTED scalar, as YAML does", () => {
    const text = agent({ extra: 'agents:\n  - "Code Issue #2"' });
    expect(parseAgentReferences(text)).toEqual(["Code Issue #2"]);
  });

  it("keeps a hash with no preceding space", () => {
    const text = agent({ extra: "agents:\n  - Agent#2" });
    expect(parseAgentReferences(text)).toEqual(["Agent#2"]);
  });
});

describe("documentClaimsCopilotSurface", () => {
  it("recognises the directory-path spelling", () => {
    expect(documentClaimsCopilotSurface("Custom agents live in .github/agents/*.agent.md.")).toBe(
      true,
    );
  });

  it("recognises the bare-filename spelling the SKILL.md files use", () => {
    // Path-only matching found ONE of the seven skill references, which made the runner's
    // skill-gathering loop near-inert for exactly the documents most likely to dangle
    // (#1282, found by the panel).
    expect(
      documentClaimsCopilotSurface(
        "Execute with the **Code Review** agent (`code-review.agent.md`).",
      ),
    ).toBe(true);
  });

  it("stays false on prose naming neither", () => {
    expect(documentClaimsCopilotSurface("Subagents live in .claude/agents/.")).toBe(false);
    expect(documentClaimsCopilotSurface(null)).toBe(false);
  });

  it("pins its filename literal to COPILOT_AGENT_SUFFIX", () => {
    // The regex is a literal because Semgrep blocks `new RegExp(<var>)`. This is what
    // stops the literal and the constant drifting apart.
    expect(documentClaimsCopilotSurface(`probe${COPILOT_AGENT_SUFFIX}`)).toBe(true);
  });
});

describe("parseSurfaceMarker", () => {
  it("distinguishes absent from malformed", () => {
    expect(parseSurfaceMarker("nothing here")).toBeNull();
    expect(parseSurfaceMarker("<!-- surface: copilot — see #1 -->")).toEqual({
      token: "copilot",
      surface: null,
      justification: "see #1",
    });
  });

  it("recognises every surface token the SURFACES map defines", () => {
    for (const token of SURFACE_TOKENS) {
      const parsed = parseSurfaceMarker(`<!-- surface: ${token} — because #1282 -->`);
      expect(parsed?.surface).toBe(token.replace(/-only$/, ""));
    }
  });

  it("accepts a hyphen or colon separator as well as an em dash", () => {
    expect(parseSurfaceMarker("<!-- surface: claude-only - see #7 -->")?.justification).toBe(
      "see #7",
    );
    expect(parseSurfaceMarker("<!-- surface: claude-only: see #7 -->")?.justification).toBe(
      "see #7",
    );
  });

  it("reports an empty justification rather than throwing", () => {
    expect(parseSurfaceMarker("<!-- surface: copilot-only -->")).toEqual({
      token: "copilot-only",
      surface: "copilot",
      justification: "",
    });
  });

  it("does not lose a marker whose justification contains '>'", () => {
    // With `[^>]*?` the whole marker failed to match and read as ABSENT, so the agent was
    // reported as an unexplained orphan (#1282, found by the panel).
    expect(
      parseSurfaceMarker("<!-- surface: claude-only — kept while a > b, see #1282 -->"),
    ).toEqual({
      token: "claude-only",
      surface: "claude",
      justification: "kept while a > b, see #1282",
    });
  });

  it("stops at the FIRST close, so a second marker cannot be swallowed", () => {
    const text = "<!-- surface: copilot-only — see #1 --> then <!-- surface: claude-only — #2 -->";
    expect(parseSurfaceMarker(text)?.justification).toBe("see #1");
  });
});

describe("checkCopilotAgent", () => {
  it("passes a well-formed agent", () => {
    expect(checkCopilotAgent({ slug: "code-review", text: agent({}), knownSlugs: [] })).toEqual([]);
  });

  it("fails an unreadable file rather than skipping it", () => {
    const problems = checkCopilotAgent({ slug: "code-review", text: null, knownSlugs: [] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("missing or unreadable");
  });

  it("fails a file with no closed frontmatter fence", () => {
    const problems = checkCopilotAgent({
      slug: "code-review",
      text: "---\nname: Code Review\nno closing fence",
      knownSlugs: [],
    });
    expect(problems[0]).toContain("no closed --- frontmatter block");
  });

  it("fails when the name slug does not match the filename", () => {
    const problems = checkCopilotAgent({
      slug: "code-review",
      text: agent({ name: "Code Reviewer" }),
      knownSlugs: [],
    });
    expect(problems.join("\n")).toContain('slugifies to "code-reviewer"');
  });

  it("fails a missing name", () => {
    const text = ["---", "description: " + "x".repeat(60), "---", "body"].join("\n");
    expect(checkCopilotAgent({ slug: "x", text, knownSlugs: [] }).join("\n")).toContain(
      'missing "name"',
    );
  });

  it("fails a missing description", () => {
    const text = ["---", "name: Code Review", "---", "body"].join("\n");
    expect(checkCopilotAgent({ slug: "code-review", text, knownSlugs: [] }).join("\n")).toContain(
      'missing "description"',
    );
  });

  it("fails a description under the 40-char floor", () => {
    const problems = checkCopilotAgent({
      slug: "code-review",
      text: agent({ description: "Reviews code." }),
      knownSlugs: [],
    });
    expect(problems.join("\n")).toContain("under the 40-char floor");
  });

  it("fails a description YAML truncated at an unquoted ' #'", () => {
    const problems = checkCopilotAgent({
      slug: "code-review",
      text: agent({
        description: "Reviews pull requests thoroughly and opens a PR that says #1282 exactly.",
      }),
      knownSlugs: [],
    });
    expect(problems.join("\n")).toContain("YAML discards everything");
  });

  it("fails a handoff naming an agent that does not exist", () => {
    const problems = checkCopilotAgent({
      slug: "code-planner",
      text: agent({
        name: "Code Planner",
        extra: "handoffs:\n  - label: Go\n    agent: Ghost Agent",
      }),
      knownSlugs: ["code-planner", "code-issue"],
    });
    expect(problems.join("\n")).toContain("ghost-agent.agent.md does not exist");
  });

  it("passes a handoff naming an agent that does exist", () => {
    const problems = checkCopilotAgent({
      slug: "code-planner",
      text: agent({
        name: "Code Planner",
        extra: "handoffs:\n  - label: Go\n    agent: Code Issue",
      }),
      knownSlugs: ["code-planner", "code-issue"],
    });
    expect(problems).toEqual([]);
  });

  it("fails an agents: entry naming a nonexistent agent", () => {
    const problems = checkCopilotAgent({
      slug: "orchestrator",
      text: agent({ name: "Orchestrator", extra: "agents:\n  - Nope" }),
      knownSlugs: ["orchestrator"],
    });
    expect(problems.join("\n")).toContain("nope.agent.md does not exist");
  });

  it("fails a self-reference", () => {
    const problems = checkCopilotAgent({
      slug: "orchestrator",
      text: agent({ name: "Orchestrator", extra: "agents:\n  - Orchestrator" }),
      knownSlugs: ["orchestrator"],
    });
    expect(problems.join("\n")).toContain("names itself");
  });

  it("fails a reference that slugifies to nothing", () => {
    const problems = checkCopilotAgent({
      slug: "orchestrator",
      text: agent({ name: "Orchestrator", extra: 'agents:\n  - "!!!"' }),
      knownSlugs: ["orchestrator"],
    });
    expect(problems.join("\n")).toContain("slugifies to nothing");
  });
});

describe("checkRosterParity", () => {
  const paired = {
    copilotFiles: { "code-review": agent({}) },
    claudeFiles: { "code-review": "x" },
  };

  it("passes when both surfaces carry the same roster", () => {
    expect(checkRosterParity(paired)).toEqual([]);
  });

  it("fails a Copilot-only agent with no marker", () => {
    const problems = checkRosterParity({
      copilotFiles: { orchestrator: agent({ name: "Orchestrator" }) },
      claudeFiles: {},
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${CLAUDE_AGENT_DIR}/orchestrator.md does not`);
    expect(problems[0]).toContain("surface: copilot-only");
  });

  it("fails a Claude-only agent with no marker", () => {
    const problems = checkRosterParity({
      copilotFiles: {},
      claudeFiles: { "adversarial-reviewer": "---\nname: adversarial-reviewer\n---\n" },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${COPILOT_AGENT_DIR}/adversarial-reviewer.agent.md does not`);
  });

  it("passes a Copilot-only agent whose marker cites an issue", () => {
    const problems = checkRosterParity({
      copilotFiles: {
        orchestrator: agent({
          name: "Orchestrator",
          body: "<!-- surface: copilot-only — retired on Claude Code in #1145 -->",
        }),
      },
      claudeFiles: {},
    });
    expect(problems).toEqual([]);
  });

  it("passes a marker citing an ADR path instead of an issue", () => {
    const problems = checkRosterParity({
      copilotFiles: {
        orchestrator: agent({
          name: "Orchestrator",
          body: "<!-- surface: copilot-only — see docs/decisions/0003-retire.md -->",
        }),
      },
      claudeFiles: {},
    });
    expect(problems).toEqual([]);
  });

  it("fails a marker with no issue or ADR citation", () => {
    const problems = checkRosterParity({
      copilotFiles: {
        orchestrator: agent({
          name: "Orchestrator",
          body: "<!-- surface: copilot-only — not needed there -->",
        }),
      },
      claudeFiles: {},
    });
    expect(problems.join("\n")).toContain("cites no issue");
  });

  it("fails a marker with an empty justification", () => {
    const problems = checkRosterParity({
      copilotFiles: {
        orchestrator: agent({ name: "Orchestrator", body: "<!-- surface: copilot-only -->" }),
      },
      claudeFiles: {},
    });
    expect(problems.join("\n")).toContain("cites no issue");
  });

  it("fails an unrecognised surface token rather than granting the exemption", () => {
    const problems = checkRosterParity({
      copilotFiles: {
        orchestrator: agent({
          name: "Orchestrator",
          body: "<!-- surface: copilot — retired in #1145 -->",
        }),
      },
      claudeFiles: {},
    });
    expect(problems.join("\n")).toContain("is not one of");
  });

  it("fails a marker naming the surface the agent is ABSENT from", () => {
    const problems = checkRosterParity({
      copilotFiles: {
        orchestrator: agent({
          name: "Orchestrator",
          body: "<!-- surface: claude-only — retired in #1145 -->",
        }),
      },
      claudeFiles: {},
    });
    expect(problems.join("\n")).toContain("names the surface the agent is");
  });

  it("fails a STALE marker on an agent that exists on both surfaces", () => {
    const problems = checkRosterParity({
      copilotFiles: {
        "code-review": agent({ body: "<!-- surface: copilot-only — see #1145 -->" }),
      },
      claudeFiles: { "code-review": "---\nname: code-review\n---\n" },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("exists on BOTH surfaces");
  });

  it("fails a stale marker sitting on the Claude half too", () => {
    const problems = checkRosterParity({
      copilotFiles: { "code-review": agent({}) },
      claudeFiles: {
        "code-review": "---\nname: code-review\n---\n<!-- surface: claude-only — #1 -->",
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${CLAUDE_AGENT_DIR}/code-review.md`);
  });
});

describe("checkSurfaceDocumented", () => {
  it("is silent when the surface has definitions", () => {
    expect(
      checkSurfaceDocumented({
        copilotFiles: { "code-review": agent({}) },
        surfaceDocs: { "AGENTS.md": "Custom agents live in .github/agents/*.agent.md." },
      }),
    ).toEqual([]);
  });

  it("is silent when the surface is absent AND nothing claims it exists", () => {
    expect(
      checkSurfaceDocumented({
        copilotFiles: {},
        surfaceDocs: { "AGENTS.md": "This repo has no Copilot agents." },
      }),
    ).toEqual([]);
  });

  it("FAILS when the surface is empty but a document still points at it", () => {
    const problems = checkSurfaceDocumented({
      copilotFiles: {},
      surfaceDocs: {
        "AGENTS.md": "Custom agents live in .github/agents/*.agent.md.",
        ".github/copilot-instructions.md": "no mention",
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("AGENTS.md");
    expect(problems[0]).not.toContain("copilot-instructions.md");
  });

  it("names every claiming document, sorted", () => {
    const problems = checkSurfaceDocumented({
      copilotFiles: {},
      surfaceDocs: {
        "AGENTS.md": ".github/agents/",
        ".github/copilot-instructions.md": ".github/agents/",
      },
    });
    expect(problems[0]).toContain(".github/copilot-instructions.md, AGENTS.md");
  });

  it("ignores an unreadable document rather than treating null as a claim", () => {
    expect(
      checkSurfaceDocumented({ copilotFiles: {}, surfaceDocs: { "AGENTS.md": null } }),
    ).toEqual([]);
  });
});

describe("verifyCopilotSurface", () => {
  it("skips the per-file and parity rules when no Copilot definition was gathered", () => {
    const report = verifyCopilotSurface({ claudeFiles: { "code-issue": "x", research: "y" } });
    expect(report.problems).toEqual([]);
  });

  it("still fails a wholesale-deleted surface that documents claim exists", () => {
    const report = verifyCopilotSurface({
      claudeFiles: { "code-issue": "x" },
      surfaceDocs: { "AGENTS.md": "agents live in .github/agents/" },
    });
    expect(report.problems.join("\n")).toContain("holds no .agent.md definition");
  });

  it("passes a consistent two-surface fleet", () => {
    const report = verifyCopilotSurface({
      copilotFiles: {
        "code-issue": agent({ name: "Code Issue", extra: "agents:\n  - Code Review" }),
        "code-review": agent({}),
      },
      claudeFiles: { "code-issue": "a", "code-review": "b" },
    });
    expect(report.problems).toEqual([]);
  });

  it("wires checkRosterParity, not just the per-file rules", () => {
    // Pins the CALL. A deletability sweep found `checkRosterParity(...)` removable from
    // this function with the whole suite green, because every parity arm invoked the
    // exported function directly and nothing asserted it was reachable from here (#1249).
    const report = verifyCopilotSurface({
      copilotFiles: { orchestrator: agent({ name: "Orchestrator" }) },
      claudeFiles: {},
    });
    expect(report.problems.join("\n")).toContain(".claude/agents/orchestrator.md does not");
  });

  it("resolves the reference graph against the whole gathered directory, not one file", () => {
    const report = verifyCopilotSurface({
      copilotFiles: { "code-issue": agent({ name: "Code Issue", extra: "agents:\n  - Research" }) },
      claudeFiles: { "code-issue": "a" },
    });
    expect(report.problems.join("\n")).toContain("research.agent.md does not exist");
  });
});
