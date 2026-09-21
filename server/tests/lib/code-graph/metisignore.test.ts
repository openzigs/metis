/**
 * Issue #308 — `.metisignore` filter tests.
 */
import { describe, it, expect } from "vitest";
import {
  compileMetisignore,
  isIgnored,
  DEFAULT_METISIGNORE,
} from "../../../src/lib/code-graph/metisignore.js";

describe(".metisignore matcher", () => {
  it("ignores blank lines and comments", () => {
    const rules = compileMetisignore("\n# comment\n\n  # leading-space-comment\nfoo\n");
    expect(rules).toHaveLength(1);
  });

  it("matches simple top-level filenames", () => {
    const rules = compileMetisignore("README.md\n");
    expect(isIgnored(rules, "README.md")).toBe(true);
    expect(isIgnored(rules, "src/README.md")).toBe(true);
    expect(isIgnored(rules, "readme.md")).toBe(false);
  });

  it("supports anchored patterns with a leading slash", () => {
    const rules = compileMetisignore("/build\n");
    expect(isIgnored(rules, "build", true)).toBe(true);
    expect(isIgnored(rules, "src/build", true)).toBe(false);
  });

  it("supports trailing slash for directory-only patterns", () => {
    const rules = compileMetisignore("logs/\n");
    expect(isIgnored(rules, "logs", true)).toBe(true);
    expect(isIgnored(rules, "logs", false)).toBe(false);
    expect(isIgnored(rules, "src/logs", true)).toBe(true);
  });

  it("expands * to match within a single segment", () => {
    const rules = compileMetisignore("*.min.js\n");
    expect(isIgnored(rules, "vendor.min.js")).toBe(true);
    expect(isIgnored(rules, "src/vendor.min.js")).toBe(true);
  });

  it("expands ** to cross slashes", () => {
    const rules = compileMetisignore("**/*.generated.ts\n");
    expect(isIgnored(rules, "a/b/c.generated.ts")).toBe(true);
    expect(isIgnored(rules, "a/b/c.ts")).toBe(false);
  });

  it("honours negation rules", () => {
    const rules = compileMetisignore("vendor/\n!vendor/keep.ts\n");
    expect(isIgnored(rules, "vendor/junk.ts")).toBe(true);
    expect(isIgnored(rules, "vendor/keep.ts")).toBe(false);
  });

  it("DEFAULT_METISIGNORE excludes node_modules and coverage", () => {
    const rules = compileMetisignore(DEFAULT_METISIGNORE);
    expect(isIgnored(rules, "node_modules/foo/index.js")).toBe(true);
    expect(isIgnored(rules, "coverage/lcov.info")).toBe(true);
    expect(isIgnored(rules, "src/index.ts")).toBe(false);
  });

  it("excludes .git directory", () => {
    const rules = compileMetisignore(DEFAULT_METISIGNORE);
    expect(isIgnored(rules, ".git/HEAD")).toBe(true);
  });

  it("question mark matches a single non-slash character", () => {
    const rules = compileMetisignore("foo?.txt\n");
    expect(isIgnored(rules, "foo1.txt")).toBe(true);
    expect(isIgnored(rules, "fooab.txt")).toBe(false);
  });

  it("returns false on an empty rule list", () => {
    expect(isIgnored([], "anything.ts")).toBe(false);
  });
});
