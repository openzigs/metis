/**
 * Tests for Epic #486 / Issue #490 — Document Assembler.
 */
import { describe, it, expect } from "vitest";
import { assembleDocument } from "../../src/lib/docs-gen/assembler.js";
import type { DocSection } from "../../src/lib/docs-gen/discovery-agent.js";

function makeSection(overrides: Partial<DocSection> = {}): DocSection {
  return {
    symbolName: "MyModule.myFunction",
    symbolKind: "function",
    modulePath: "src/lib/utils.ts",
    summary: "A utility function that does things.",
    parameters: [{ name: "input", type: "string", description: "The input data" }],
    returns: "boolean",
    rationale: ["Designed for performance"],
    callsTo: ["MyModule.helperA"],
    calledBy: ["MainApp.run"],
    formulas: [],
    complexity: "medium",
    ...overrides,
  };
}

describe("assembleDocument", () => {
  it("generates a title and TOC", () => {
    const sections = [makeSection()];
    const result = assembleDocument(sections, { projectId: "test-proj" });
    expect(result).toContain("# Generated Documentation");
    expect(result).toContain("## Table of Contents");
    expect(result).toContain("myFunction");
  });

  it("uses custom title when provided", () => {
    const sections = [makeSection()];
    const result = assembleDocument(sections, { projectId: "p", title: "API Reference" });
    expect(result).toContain("# API Reference");
  });

  it("groups sections by module path", () => {
    const sections = [
      makeSection({ symbolName: "A.foo", modulePath: "src/moduleA/foo.ts" }),
      makeSection({ symbolName: "A.bar", modulePath: "src/moduleA/bar.ts" }),
      makeSection({ symbolName: "B.baz", modulePath: "src/moduleB/baz.ts" }),
    ];
    const result = assembleDocument(sections, { projectId: "p" });
    expect(result).toContain("## src/moduleA");
    expect(result).toContain("## src/moduleB");
  });

  it("renders parameters table", () => {
    const sections = [makeSection()];
    const result = assembleDocument(sections, { projectId: "p" });
    expect(result).toContain("| `input` | `string` | The input data |");
  });

  it("renders return type", () => {
    const sections = [makeSection({ returns: "Promise<void>" })];
    const result = assembleDocument(sections, { projectId: "p" });
    expect(result).toContain("**Returns:** `Promise<void>`");
  });

  it("renders rationale as blockquote", () => {
    const sections = [makeSection({ rationale: ["This is the why."] })];
    const result = assembleDocument(sections, { projectId: "p" });
    expect(result).toContain("> This is the why.");
  });

  it("renders call graph dependencies", () => {
    const sections = [makeSection({ callsTo: ["util.format"], calledBy: ["main.init"] })];
    const result = assembleDocument(sections, { projectId: "p" });
    expect(result).toContain("- Calls: `format`");
    expect(result).toContain("- Called by: `init`");
  });

  it("generates mermaid diagram when there are call edges", () => {
    const sections = [
      makeSection({ symbolName: "A.foo", callsTo: ["B.bar"] }),
      makeSection({ symbolName: "B.bar", callsTo: [] }),
    ];
    const result = assembleDocument(sections, { projectId: "p" });
    expect(result).toContain("```mermaid");
    expect(result).toContain("graph LR");
  });

  it("handles empty sections array", () => {
    const result = assembleDocument([], { projectId: "p" });
    expect(result).toContain("No documentable symbols found");
  });

  it("includes formula appendix when formulas present", () => {
    const sections = [
      makeSection({
        formulas: [
          {
            kind: "constant",
            expression: "3.14159",
            description: "Constant PI",
            name: "PI",
            resolvedValue: "3.14159",
            filePath: "math.ts",
            startLine: 1,
            endLine: 1,
            symbolContext: null,
          },
        ],
      }),
    ];
    const result = assembleDocument(sections, { projectId: "p" });
    expect(result).toContain("## Formulas & Business Rules");
    expect(result).toContain("Constants");
  });

  it("omits formulas section when includeFormulas is false", () => {
    const sections = [
      makeSection({
        formulas: [
          {
            kind: "constant",
            expression: "42",
            description: "Answer",
            name: "ANSWER",
            resolvedValue: "42",
            filePath: "x.ts",
            startLine: 1,
            endLine: 1,
            symbolContext: null,
          },
        ],
      }),
    ];
    const result = assembleDocument(sections, { projectId: "p", includeFormulas: false });
    expect(result).not.toContain("## Formulas & Business Rules");
  });

  it("renders complexity indicator", () => {
    const sections = [makeSection({ complexity: "high" })];
    const result = assembleDocument(sections, { projectId: "p" });
    expect(result).toContain("**Complexity:** high");
  });
});
