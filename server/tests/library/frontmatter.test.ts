/**
 * Frontmatter parser tests \u2014 pure functions, no DB.
 *
 * Covers: happy-path skill + agent parsing, malformed input, security guards
 * (no `!!js/function`, unknown keys rejected, oversized bodies rejected, BOM
 * stripping), and the helper utilities (slugify + bumpVersion).
 */
import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  FrontmatterError,
  MAX_BODY_BYTES,
  MAX_FRONTMATTER_BYTES,
  parseAgentSource,
  parseSkillSource,
  slugifyKey,
} from "../../src/lib/library/frontmatter.js";

const SKILL_SAMPLE = `---
name: code-issue
description: TDD workflow
version: 1.2.3
tools:
  - github
  - context7
tags: [phase-10, dev]
---

# Body

Step 1
`;

const AGENT_SAMPLE = `---
name: code-reviewer
displayName: Code Reviewer
description: Review pull requests
model: gpt-4
tools: [github]
tags: [dev]
---

You are an expert reviewer.
`;

describe("parseSkillSource", () => {
  it("parses valid frontmatter and computes a stable sha256", () => {
    const parsed = parseSkillSource(SKILL_SAMPLE);
    expect(parsed.frontmatter.name).toBe("code-issue");
    expect(parsed.frontmatter.version).toBe("1.2.3");
    expect(parsed.frontmatter.tools).toEqual(["github", "context7"]);
    expect(parsed.frontmatter.tags).toEqual(["phase-10", "dev"]);
    expect(parsed.body).toContain("# Body");
    expect(parsed.contentSha256).toMatch(/^[0-9a-f]{64}$/);

    const again = parseSkillSource(SKILL_SAMPLE);
    expect(again.contentSha256).toBe(parsed.contentSha256);
  });

  it("strips a UTF-8 BOM before locating the delimiter", () => {
    const parsed = parseSkillSource(`\uFEFF${SKILL_SAMPLE}`);
    expect(parsed.frontmatter.name).toBe("code-issue");
  });

  it("defaults missing optional fields", () => {
    const minimal = `---\nname: tiny\n---\n`;
    const parsed = parseSkillSource(minimal);
    expect(parsed.frontmatter.description).toBe("");
    expect(parsed.frontmatter.version).toBe("0.1.0");
    expect(parsed.body).toBe("");
  });

  it("rejects non-string input", () => {
    expect(() => parseSkillSource(undefined as unknown as string)).toThrow(FrontmatterError);
  });

  it("rejects empty input", () => {
    expect(() => parseSkillSource("")).toThrow(/EMPTY/);
  });

  it("rejects missing opening delimiter", () => {
    expect(() => parseSkillSource("name: foo\n")).toThrow(/MISSING_FRONTMATTER/);
  });

  it("rejects unterminated frontmatter", () => {
    expect(() => parseSkillSource("---\nname: foo\nno close")).toThrow(/UNTERMINATED/);
  });

  it("rejects empty frontmatter block", () => {
    expect(() => parseSkillSource("---\n# only a comment\n---\nbody")).toThrow(/EMPTY_FRONTMATTER/);
  });

  it("rejects YAML mapping that is actually a list", () => {
    expect(() => parseSkillSource("---\n- foo\n- bar\n---\nbody")).toThrow(/INVALID_FRONTMATTER/);
  });

  it("rejects YAML parse errors", () => {
    expect(() => parseSkillSource("---\nname: : :\n---\n")).toThrow(/YAML_PARSE_ERROR/);
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parseSkillSource("---\nname: x\nunknown: yes\n---\n")).toThrow(/UNKNOWN_KEY/);
  });

  it("rejects keys with invalid characters", () => {
    expect(() => parseSkillSource(`---\n"a b": yes\nname: x\n---\n`)).toThrow(/INVALID_KEY/);
  });

  it("rejects oversized frontmatter", () => {
    const huge = "x".repeat(MAX_FRONTMATTER_BYTES + 100);
    expect(() => parseSkillSource(`---\nname: foo\ntags: ['${huge}']\n---\n`)).toThrow(
      /FRONTMATTER_TOO_LARGE/,
    );
  });

  it("rejects oversized body", () => {
    const huge = "y".repeat(MAX_BODY_BYTES + 100);
    expect(() => parseSkillSource(`---\nname: foo\n---\n${huge}`)).toThrow(/BODY_TOO_LARGE/);
  });

  it("treats `!!js/function` style tags as parse errors (FAILSAFE_SCHEMA)", () => {
    const malicious = `---\nname: x\nbad: !!js/function "function() {}"\n---\nbody`;
    expect(() => parseSkillSource(malicious)).toThrow(FrontmatterError);
  });

  it("rejects fields that fail zod validation", () => {
    expect(() => parseSkillSource(`---\nname: ""\n---\nbody`)).toThrow(/VALIDATION_ERROR/);
  });
});

describe("parseAgentSource", () => {
  it("parses valid agent definition", () => {
    const parsed = parseAgentSource(AGENT_SAMPLE);
    expect(parsed.frontmatter.name).toBe("code-reviewer");
    expect(parsed.frontmatter.displayName).toBe("Code Reviewer");
    expect(parsed.frontmatter.tools).toEqual(["github"]);
    expect(parsed.body).toContain("expert reviewer");
  });

  it("rejects unknown agent keys", () => {
    expect(() => parseAgentSource("---\nname: x\nfoo: bar\n---\nbody")).toThrow(/UNKNOWN_KEY/);
  });
});

describe("slugifyKey", () => {
  it("normalises name to kebab-case", () => {
    expect(slugifyKey("Code Issue Resolver!")).toBe("code-issue-resolver");
  });
  it("rejects names that produce empty slugs", () => {
    expect(() => slugifyKey("!!!")).toThrow(/INVALID_NAME/);
  });
});

describe("bumpVersion", () => {
  it("bumps semver patches", () => {
    expect(bumpVersion("1.2.3", new Set())).toBe("1.2.4");
  });
  it("bumps integer-only versions", () => {
    expect(bumpVersion("4", new Set())).toBe("5");
  });
  it("falls back to suffix bumps for arbitrary strings", () => {
    expect(bumpVersion("alpha", new Set())).toBe("alpha-1");
  });
  it("walks forward when the next slot is taken", () => {
    expect(bumpVersion("1.0.0", new Set(["1.0.1"]))).toBe("1.0.2");
  });
});
