/**
 * Issue #1016 — the shared code qualified-name convention.
 *
 * These tests pin the shape the parsers emit AND the invariant every consumer
 * relies on, so the eval corpus's self-check has something real to derive from.
 */
import { describe, expect, it } from "vitest";
import {
  buildCodeQualifiedName,
  CODE_QUALIFIED_NAME_SEPARATOR,
  codeQualifiedNameSegments,
  isCodeQualifiedNameOf,
  moduleQualifiedName,
} from "../src/lib/code-graph/qualified-name.js";
import { parseSource } from "../src/lib/code-graph/parsers.js";

describe("code qualified-name convention", () => {
  it("roots a module symbol at the file path itself", () => {
    expect(moduleQualifiedName("src/a/b.ts")).toBe("src/a/b.ts");
  });

  it("joins declaration segments with the code separator", () => {
    expect(buildCodeQualifiedName("src/a/B.java", "B", "run")).toBe("src/a/B.java::B::run");
    expect(CODE_QUALIFIED_NAME_SEPARATOR).toBe("::");
  });

  it("drops empty segments so an absent enclosing type never doubles the separator", () => {
    expect(buildCodeQualifiedName("src/a/b.ts", "", "run")).toBe("src/a/b.ts::run");
  });

  it("splits into [filePath, ...declarations] without splitting the path", () => {
    expect(codeQualifiedNameSegments("src/a/B.java::B::run")).toEqual(["src/a/B.java", "B", "run"]);
    // A path containing dots is NOT split — the #1002 corruption was exactly this.
    expect(codeQualifiedNameSegments("e2e/fixtures/api-base.ts")).toEqual([
      "e2e/fixtures/api-base.ts",
    ]);
  });

  it("recognises a name rooted at its file, and rejects a sibling-path prefix", () => {
    expect(isCodeQualifiedNameOf("a/Foo.ts", "a/Foo.ts")).toBe(true);
    expect(isCodeQualifiedNameOf("a/Foo.ts::x", "a/Foo.ts")).toBe(true);
    // `startsWith(filePath)` alone would wrongly accept this.
    expect(isCodeQualifiedNameOf("a/FooBar.ts::x", "a/Foo.ts")).toBe(false);
    expect(isCodeQualifiedNameOf("anything", "")).toBe(false);
  });
});

describe("the real parser emits the convention (the source of the expectation)", () => {
  it("roots every TypeScript symbol at the file path with the code separator", () => {
    const parsed = parseSource(
      "src/demo/thing.ts",
      "export class Thing {}\nexport function go() {}\n",
      "ts",
    );
    const byKind = new Map(parsed.symbols.map((s) => [s.kind, s.qualifiedName]));
    expect(byKind.get("module")).toBe("src/demo/thing.ts");
    expect(byKind.get("class")).toBe("src/demo/thing.ts::Thing");
    expect(byKind.get("function")).toBe("src/demo/thing.ts::go");
    for (const symbol of parsed.symbols) {
      expect(isCodeQualifiedNameOf(symbol.qualifiedName, "src/demo/thing.ts")).toBe(true);
    }
  });
});
