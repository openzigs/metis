/**
 * Issue #432 — Codex skill emission + AGENTS.md merge tests.
 */
import { describe, expect, it } from "vitest";
import { SPECKIT_COMMANDS } from "@metis/shared";
import {
  AGENTS_MD_BEGIN,
  AGENTS_MD_END,
  CODEX_ALIAS_MAP,
  buildAgentsMdSection,
  emitCodexAgentsMd,
  emitHostFiles,
  HOSTS,
  isHostKey,
  mergeAgentsMd,
  resolveCodexAlias,
} from "./hosts.js";

const ctx = { projectId: "p1", apiBaseUrl: "https://metis.local" };

describe("CODEX_ALIAS_MAP", () => {
  it("maps every speckit.* command to a $speckit-* alias", () => {
    for (const cmd of SPECKIT_COMMANDS) {
      const alias = CODEX_ALIAS_MAP[cmd];
      expect(alias).toBeDefined();
      expect(alias).toMatch(/^\$speckit-[a-z]+$/);
      expect(alias).toBe(`$${cmd.replace(/\./g, "-")}`);
    }
  });

  it("resolveCodexAlias is the inverse of CODEX_ALIAS_MAP", () => {
    for (const [canonical, alias] of Object.entries(CODEX_ALIAS_MAP)) {
      expect(resolveCodexAlias(alias)).toBe(canonical);
    }
  });

  it("resolveCodexAlias returns null for unknown aliases", () => {
    expect(resolveCodexAlias("$nope-thing")).toBeNull();
  });
});

describe("HOSTS", () => {
  it("includes codex", () => {
    expect(HOSTS).toContain("codex");
    expect(isHostKey("codex")).toBe(true);
  });
});

describe("emitHostFiles(codex)", () => {
  it("writes one skill file per command under .codex/skills/speckit/ using the dash form", () => {
    const files = emitHostFiles("codex", ctx);
    expect(files).toHaveLength(SPECKIT_COMMANDS.length);
    for (const cmd of SPECKIT_COMMANDS) {
      const alias = CODEX_ALIAS_MAP[cmd]!.replace(/^\$/, "");
      const expected = `.codex/skills/speckit/${alias}.md`;
      expect(files.some((f) => f.relPath === expected)).toBe(true);
    }
  });

  it("each codex skill file has the metis API endpoint baked in", () => {
    const files = emitHostFiles("codex", ctx);
    for (const f of files) {
      expect(f.content).toContain("https://metis.local/api/projects/p1/spec-kit/commands/");
      expect(f.content).toContain("Authorization: Bearer ${METIS_TOKEN}");
    }
  });
});

describe("buildAgentsMdSection", () => {
  it("includes start + end markers and every alias", () => {
    const section = buildAgentsMdSection(ctx);
    expect(section.startsWith(AGENTS_MD_BEGIN)).toBe(true);
    expect(section.trimEnd().endsWith(AGENTS_MD_END)).toBe(true);
    for (const alias of Object.values(CODEX_ALIAS_MAP)) {
      expect(section).toContain(alias);
    }
    expect(section).toContain(
      "POST https://metis.local/api/projects/p1/spec-kit/commands/speckit.specify",
    );
  });
});

describe("mergeAgentsMd", () => {
  it("returns a fresh section when given an empty document", () => {
    const merged = mergeAgentsMd("", ctx);
    expect(merged.startsWith(AGENTS_MD_BEGIN)).toBe(true);
  });

  it("appends after a blank line when no markers are present", () => {
    const existing = "# Project AGENTS\n\nWelcome to the workspace.\n";
    const merged = mergeAgentsMd(existing, ctx);
    expect(merged).toContain("# Project AGENTS");
    expect(merged).toContain(AGENTS_MD_BEGIN);
    expect(merged.indexOf("# Project AGENTS")).toBeLessThan(merged.indexOf(AGENTS_MD_BEGIN));
    // Blank line separator preserved.
    expect(merged).toContain("Welcome to the workspace.\n\n<!-- speckit:start -->");
  });

  it("replaces only the block between markers when they exist (idempotent)", () => {
    const before = "# Project AGENTS\n\nSome prose.\n\n";
    const after = "\n\nMore prose at the end.\n";
    const original = `${before}${AGENTS_MD_BEGIN}\nstale content\n${AGENTS_MD_END}${after}`;
    const merged = mergeAgentsMd(original, ctx);
    expect(merged).toContain("Some prose.");
    expect(merged).toContain("More prose at the end.");
    expect(merged).not.toContain("stale content");
    // Re-running should yield byte-identical output.
    expect(mergeAgentsMd(merged, ctx)).toBe(merged);
  });

  it("preserves prose surrounding the markers exactly", () => {
    const prefix = "# AGENTS\n\nIntro paragraph.\n\n";
    const suffix = "\n\n## Other tools\n\n- foo\n- bar\n";
    const original = `${prefix}${AGENTS_MD_BEGIN}\nold\n${AGENTS_MD_END}${suffix}`;
    const merged = mergeAgentsMd(original, ctx);
    expect(merged.startsWith(prefix)).toBe(true);
    expect(merged.endsWith(suffix)).toBe(true);
  });
});

describe("emitCodexAgentsMd", () => {
  it("returns a HostFile keyed at AGENTS.md with the merged content", () => {
    const file = emitCodexAgentsMd(ctx, "# Existing\n");
    expect(file.relPath).toBe("AGENTS.md");
    expect(file.content).toContain("# Existing");
    expect(file.content).toContain(AGENTS_MD_BEGIN);
  });
});
