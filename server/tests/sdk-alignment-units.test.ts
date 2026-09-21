/**
 * Unit tests for the `/model` slash-command parser (#120) and skill-directories
 * scanner (#113) — the two pure-functional new modules that are easy to fully
 * cover.
 */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import { effectiveModel, parseModelCommand } from "../src/lib/ai/model-switch.js";
import {
  SkillDirectoryError,
  isWithinRoot,
  resolveAllowedSkillRoots,
  scan,
  scanDirectory,
  validateDirectoryEntry,
} from "../src/lib/library/skill-directories.js";
import { DEFAULT_SESSION_SNAPSHOT_INTERVAL } from "@metis/shared";
import { getSnapshotInterval, shouldSnapshot } from "../src/lib/ai/session-snapshot.js";

describe("parseModelCommand (#120)", () => {
  it("parses /model <name>", () => {
    expect(parseModelCommand("/model claude-opus-4.6")).toEqual({
      model: "claude-opus-4.6",
      reasoningEffort: null,
    });
  });

  it("parses /model <name> reasoning=high", () => {
    expect(parseModelCommand("/model gpt-5.3 reasoning=high")).toEqual({
      model: "gpt-5.3",
      reasoningEffort: "high",
    });
  });

  it("parses /model <name> <effort> without reasoning= prefix", () => {
    expect(parseModelCommand("/model gpt-5.3 medium")).toEqual({
      model: "gpt-5.3",
      reasoningEffort: "medium",
    });
  });

  it("returns null for non-commands", () => {
    expect(parseModelCommand("hello world")).toBeNull();
    expect(parseModelCommand("/help")).toBeNull();
    expect(parseModelCommand("model claude")).toBeNull();
  });

  it("trims surrounding whitespace and is case-insensitive on the verb", () => {
    expect(parseModelCommand("   /MODEL  claude  ")).toEqual({
      model: "claude",
      reasoningEffort: null,
    });
  });

  it("returns null when reasoning effort is unrecognized", () => {
    expect(parseModelCommand("/model claude reasoning=ultra")).toBeNull();
  });

  it("effectiveModel prefers currentModel when set", () => {
    expect(effectiveModel({ model: "default", currentModel: "switched" })).toBe("switched");
    expect(effectiveModel({ model: "default", currentModel: null })).toBe("default");
  });
});

describe("validateDirectoryEntry (#113)", () => {
  it("rejects non-strings and empties", () => {
    expect(() => validateDirectoryEntry(123)).toThrowError(SkillDirectoryError);
    expect(() => validateDirectoryEntry("")).toThrowError(SkillDirectoryError);
    expect(() => validateDirectoryEntry("   ")).toThrowError(SkillDirectoryError);
  });

  it("rejects relative paths", () => {
    expect(() => validateDirectoryEntry("relative/path")).toThrowError(SkillDirectoryError);
  });

  it("rejects git URLs (deferred to v1.2)", () => {
    expect(() => validateDirectoryEntry("git@github.com:org/repo.git")).toThrowError(
      SkillDirectoryError,
    );
    expect(() => validateDirectoryEntry("https://github.com/org/repo.git")).toThrowError(
      SkillDirectoryError,
    );
  });

  it("rejects path traversal", () => {
    expect(() => validateDirectoryEntry("/abs/../path")).toThrowError(SkillDirectoryError);
  });

  it("accepts a clean absolute path inside an allowed root", () => {
    expect(validateDirectoryEntry("/tmp/skills", ["/tmp"])).toBe("/tmp/skills");
  });

  // Issue #1075 — the entry must also land inside an operator-configured root.
  it("rejects an absolute path outside every allowed root", () => {
    expect(() => validateDirectoryEntry("/etc", ["/tmp"])).toThrowError(SkillDirectoryError);
    expect(() => validateDirectoryEntry("/tmp-evil/skills", ["/tmp"])).toThrowError(
      SkillDirectoryError,
    );
  });

  it("accepts the allowed root itself and honours multiple roots", () => {
    expect(validateDirectoryEntry("/tmp", ["/tmp"])).toBe("/tmp");
    expect(validateDirectoryEntry("/srv/skills/a", ["/tmp", "/srv/skills"])).toBe("/srv/skills/a");
  });
});

describe("resolveAllowedSkillRoots (#1075)", () => {
  const original = process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS;
  afterEach(() => {
    if (original === undefined) delete process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS;
    else process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS = original;
  });

  it("defaults to the server's own data/skills tree when unset", () => {
    delete process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS;
    const roots = resolveAllowedSkillRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0]!.endsWith(path.join("data", "skills"))).toBe(true);
    expect(path.isAbsolute(roots[0]!)).toBe(true);
  });

  it("splits the env var on the platform delimiter and ignores blanks", () => {
    const roots = resolveAllowedSkillRoots({
      SKILL_DIRECTORIES_ALLOWED_ROOTS: ["/srv/skills", "", "  /opt/skills  "].join(path.delimiter),
    });
    expect(roots).toEqual(["/srv/skills", "/opt/skills"]);
  });

  it("falls back to the default when the env var holds only separators", () => {
    expect(
      resolveAllowedSkillRoots({ SKILL_DIRECTORIES_ALLOWED_ROOTS: path.delimiter }),
    ).toHaveLength(1);
  });
});

describe("isWithinRoot (#1075)", () => {
  it("accepts the root and its descendants, rejects siblings and ancestors", () => {
    expect(isWithinRoot("/srv/skills", "/srv/skills")).toBe(true);
    expect(isWithinRoot("/srv/skills", "/srv/skills/team/a")).toBe(true);
    expect(isWithinRoot("/srv/skills", "/srv/skills-evil")).toBe(false);
    expect(isWithinRoot("/srv/skills", "/srv")).toBe(false);
    expect(isWithinRoot("/srv/skills", "/etc")).toBe(false);
  });
});

describe("scanDirectory (#113)", () => {
  it("discovers SKILL.md files, skips disabled, surfaces errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "metis-scan-"));
    const skillA = path.join(root, "scan-deps");
    const skillB = path.join(root, "analyze-jboss");
    await fs.mkdir(skillA, { recursive: true });
    await fs.mkdir(skillB, { recursive: true });
    await fs.writeFile(
      path.join(skillA, "SKILL.md"),
      "---\nname: scan-deps\n---\nScans dependency files.\n",
    );
    await fs.writeFile(
      path.join(skillB, "SKILL.md"),
      "---\nname: analyze-jboss\n---\nReads JBoss app structure.\n",
    );
    // #1075 — `scan()` re-validates each configured directory against the
    // allowed roots, so the fixture root has to be one of them.
    const previousRoots = process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS;
    process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS = root;

    const found = await scanDirectory(root);
    expect(found.map((s) => s.slug).sort()).toEqual(["analyze-jboss", "scan-deps"]);
    const a = found.find((s) => s.slug === "scan-deps")!;
    expect(a.excerpt).toContain("Scans");
    expect(a.directorySource).toBe(root);

    // scan() respects disabledSlugs
    const result = await scan([root], ["analyze-jboss"]);
    expect(result.skills.map((s) => s.slug)).toEqual(["scan-deps"]);
    expect(result.disabled).toContain("analyze-jboss");

    // missing directory inside an allowed root surfaces no error entry
    const result2 = await scan([path.join(root, "does-not-exist")]);
    expect(result2.errors.length).toBe(0); // readdir failure inside scanDirectory is silent;
    expect(result2.skills).toEqual([]);

    // git URL surfaces a validation error
    const result3 = await scan(["https://github.com/org/repo.git"]);
    expect(result3.errors.length).toBe(1);
    expect(result3.errors[0]!.error).toMatch(/Git-backed/);

    // #1075 — a directory persisted outside the allowed roots is refused at
    // READ time too, so narrowing the roots retroactively disarms old entries.
    const result4 = await scan(["/etc"]);
    expect(result4.errors.length).toBe(1);
    expect(result4.errors[0]!.error).toMatch(/allowed skill roots/);
    expect(result4.skills).toEqual([]);

    if (previousRoots === undefined) delete process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS;
    else process.env.SKILL_DIRECTORIES_ALLOWED_ROOTS = previousRoots;
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("session snapshot helpers (#122)", () => {
  it("getSnapshotInterval falls back to default for invalid env values", () => {
    const original = process.env.SESSION_SNAPSHOT_INTERVAL;
    process.env.SESSION_SNAPSHOT_INTERVAL = "abc";
    expect(getSnapshotInterval()).toBe(DEFAULT_SESSION_SNAPSHOT_INTERVAL);
    process.env.SESSION_SNAPSHOT_INTERVAL = "0";
    expect(getSnapshotInterval()).toBe(DEFAULT_SESSION_SNAPSHOT_INTERVAL);
    process.env.SESSION_SNAPSHOT_INTERVAL = "7";
    expect(getSnapshotInterval()).toBe(7);
    if (original === undefined) delete process.env.SESSION_SNAPSHOT_INTERVAL;
    else process.env.SESSION_SNAPSHOT_INTERVAL = original;
  });

  it("shouldSnapshot only fires on multiples of the interval", () => {
    expect(shouldSnapshot(0, 5)).toBe(false);
    expect(shouldSnapshot(1, 5)).toBe(false);
    expect(shouldSnapshot(5, 5)).toBe(true);
    expect(shouldSnapshot(10, 5)).toBe(true);
    expect(shouldSnapshot(12, 5)).toBe(false);
  });
});
