/**
 * Epic #515 / Issue #516 — Unit tests for skill lazy-loading.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SkillRegistry,
  buildManifestLine,
  buildSkillManifestBlock,
  buildEagerSkillBlocks,
  getSkillLoadingMode,
  createExpandSkillHandler,
  type SkillManifestEntry,
  type SkillFullEntry,
} from "./skill-loader.js";

const makeSkill = (key: string, overrides: Partial<SkillFullEntry> = {}): SkillFullEntry => ({
  key,
  name: `Skill ${key}`,
  trigger: `do ${key}`,
  description: `Capability for ${key}`,
  instructions: `Full instructions for ${key}. These are detailed and lengthy.`,
  version: "1.0.0",
  ...overrides,
});

describe("getSkillLoadingMode", () => {
  afterEach(() => {
    delete process.env.SKILL_LOADING;
  });

  it("defaults to lazy when env is not set", () => {
    delete process.env.SKILL_LOADING;
    expect(getSkillLoadingMode()).toBe("lazy");
  });

  it("returns eager when SKILL_LOADING=eager", () => {
    process.env.SKILL_LOADING = "eager";
    expect(getSkillLoadingMode()).toBe("eager");
  });

  it("returns lazy when SKILL_LOADING=lazy", () => {
    process.env.SKILL_LOADING = "lazy";
    expect(getSkillLoadingMode()).toBe("lazy");
  });

  it("returns lazy for unrecognized values", () => {
    process.env.SKILL_LOADING = "invalid";
    expect(getSkillLoadingMode()).toBe("lazy");
  });
});

describe("buildManifestLine", () => {
  it("formats manifest line correctly", () => {
    const entry: SkillManifestEntry = {
      key: "code-review",
      name: "Code Review",
      trigger: "review code",
      description: "Reviews pull request code for quality issues",
    };
    expect(buildManifestLine(entry)).toBe(
      "code-review: review code | Reviews pull request code for quality issues",
    );
  });

  it("handles entries with minimal content", () => {
    const entry: SkillManifestEntry = {
      key: "a",
      name: "A",
      trigger: "t",
      description: "d",
    };
    expect(buildManifestLine(entry)).toBe("a: t | d");
  });
});

describe("buildSkillManifestBlock", () => {
  it("returns empty string for no entries", () => {
    expect(buildSkillManifestBlock([])).toBe("");
  });

  it("builds multi-line manifest block", () => {
    const entries: SkillManifestEntry[] = [
      { key: "code-review", name: "Code Review", trigger: "review", description: "Reviews code" },
      { key: "test-plan", name: "Test Plan", trigger: "plan tests", description: "Plans tests" },
    ];
    const block = buildSkillManifestBlock(entries);
    expect(block).toContain("[Available Skills");
    expect(block).toContain("code-review: review | Reviews code");
    expect(block).toContain("test-plan: plan tests | Plans tests");
    expect(block).toContain("expand_skill");
  });

  it("manifest block is significantly smaller than full instructions", () => {
    const entries: SkillManifestEntry[] = Array.from({ length: 10 }, (_, i) => ({
      key: `skill-${i}`,
      name: `Skill ${i}`,
      trigger: `trigger ${i}`,
      description: `Description for skill ${i}`,
    }));
    const block = buildSkillManifestBlock(entries);
    // Each manifest line is ~50 chars vs instructions of 200+ chars
    expect(block.length).toBeLessThan(1000);
  });
});

describe("buildEagerSkillBlocks", () => {
  it("returns empty array for no entries", () => {
    expect(buildEagerSkillBlocks([])).toHaveLength(0);
  });

  it("builds one system message per skill with full instructions", () => {
    const skills = [makeSkill("review"), makeSkill("plan")];
    const blocks = buildEagerSkillBlocks(skills);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.role).toBe("system");
    expect(blocks[0]!.content).toContain("[skill:review@1.0.0]");
    expect(blocks[0]!.content).toContain("Full instructions for review");
    expect(blocks[1]!.content).toContain("[skill:plan@1.0.0]");
  });

  it("handles skills with empty instructions", () => {
    const skill = makeSkill("empty", { instructions: "" });
    const blocks = buildEagerSkillBlocks([skill]);
    expect(blocks[0]!.content).toContain("[skill:empty@1.0.0]");
    expect(blocks[0]!.content).not.toContain("\n\n");
  });
});

describe("SkillRegistry", () => {
  let registry: SkillRegistry;

  describe("lazy mode", () => {
    beforeEach(() => {
      registry = new SkillRegistry("lazy");
    });

    it("reports lazy mode", () => {
      expect(registry.getMode()).toBe("lazy");
    });

    it("register and has", () => {
      const skill = makeSkill("test");
      registry.register(skill);
      expect(registry.has("test")).toBe(true);
      expect(registry.has("other")).toBe(false);
      expect(registry.size).toBe(1);
    });

    it("registerAll registers multiple skills", () => {
      registry.registerAll([makeSkill("a"), makeSkill("b"), makeSkill("c")]);
      expect(registry.size).toBe(3);
    });

    it("getManifests returns only manifest data (no instructions)", () => {
      registry.register(makeSkill("review"));
      const manifests = registry.getManifests();
      expect(manifests).toHaveLength(1);
      expect(manifests[0]).toEqual({
        key: "review",
        name: "Skill review",
        trigger: "do review",
        description: "Capability for review",
      });
      // Should NOT include instructions
      expect((manifests[0] as unknown as Record<string, unknown>).instructions).toBeUndefined();
    });

    it("expandSkill returns full instructions", () => {
      registry.register(makeSkill("review"));
      const result = registry.expandSkill("review");
      expect(result).toBe("Full instructions for review. These are detailed and lengthy.");
    });

    it("expandSkill returns null for unknown skill", () => {
      const result = registry.expandSkill("nonexistent");
      expect(result).toBeNull();
    });

    it("buildSystemMessages in lazy mode returns manifest block", () => {
      registry.registerAll([makeSkill("a"), makeSkill("b")]);
      const messages = registry.buildSystemMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe("system");
      expect(messages[0]!.content).toContain("[Available Skills");
      expect(messages[0]!.content).toContain("a:");
      expect(messages[0]!.content).toContain("b:");
      // Should NOT contain full instructions
      expect(messages[0]!.content).not.toContain("Full instructions for");
    });

    it("buildSystemMessages returns empty for no skills", () => {
      expect(registry.buildSystemMessages()).toHaveLength(0);
    });

    it("lazy mode saves ~80% tokens compared to eager", () => {
      const skills = Array.from({ length: 10 }, (_, i) =>
        makeSkill(`skill-${i}`, {
          instructions: "A".repeat(500), // 500 chars per skill
        }),
      );
      registry.registerAll(skills);
      const lazyMessages = registry.buildSystemMessages();
      const lazyTokens = lazyMessages.reduce((s, m) => s + m.content.length, 0);

      const eagerRegistry = new SkillRegistry("eager");
      eagerRegistry.registerAll(skills);
      const eagerMessages = eagerRegistry.buildSystemMessages();
      const eagerTokens = eagerMessages.reduce((s, m) => s + m.content.length, 0);

      // Lazy should be at most 30% of eager (saving ≥70%)
      expect(lazyTokens).toBeLessThan(eagerTokens * 0.3);
    });
  });

  describe("eager mode", () => {
    beforeEach(() => {
      registry = new SkillRegistry("eager");
    });

    it("reports eager mode", () => {
      expect(registry.getMode()).toBe("eager");
    });

    it("buildSystemMessages returns full instruction blocks", () => {
      registry.registerAll([makeSkill("a"), makeSkill("b")]);
      const messages = registry.buildSystemMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]!.content).toContain("Full instructions for a");
      expect(messages[1]!.content).toContain("Full instructions for b");
    });
  });

  describe("clear", () => {
    it("removes all skills", () => {
      registry = new SkillRegistry("lazy");
      registry.registerAll([makeSkill("a"), makeSkill("b")]);
      expect(registry.size).toBe(2);
      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.buildSystemMessages()).toHaveLength(0);
    });
  });
});

describe("createExpandSkillHandler", () => {
  it("returns instructions for known skill", () => {
    const registry = new SkillRegistry("lazy");
    registry.register(makeSkill("review"));
    const handler = createExpandSkillHandler(registry);

    const result = handler({ skill: "review" });
    expect(result.found).toBe(true);
    expect(result.content).toBe("Full instructions for review. These are detailed and lengthy.");
  });

  it("returns error message for unknown skill", () => {
    const registry = new SkillRegistry("lazy");
    registry.register(makeSkill("review"));
    const handler = createExpandSkillHandler(registry);

    const result = handler({ skill: "nonexistent" });
    expect(result.found).toBe(false);
    expect(result.content).toContain("not found");
    expect(result.content).toContain("review");
  });

  it("lists available skills in error message", () => {
    const registry = new SkillRegistry("lazy");
    registry.registerAll([makeSkill("a"), makeSkill("b"), makeSkill("c")]);
    const handler = createExpandSkillHandler(registry);

    const result = handler({ skill: "z" });
    expect(result.content).toContain("a");
    expect(result.content).toContain("b");
    expect(result.content).toContain("c");
  });
});
