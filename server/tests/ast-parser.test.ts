/**
 * Epic #596 / Issue #621 — AST Parser unit tests.
 */
import { describe, expect, it } from "vitest";
import {
  parseSource,
  detectLanguage,
  summarizeNode,
  type ASTNode,
} from "../src/lib/analysis/ast-parser.js";

describe("detectLanguage", () => {
  it("detects TypeScript files", () => {
    expect(detectLanguage("src/foo.ts")).toBe("typescript");
    expect(detectLanguage("src/bar.tsx")).toBe("typescript");
  });

  it("detects JavaScript files", () => {
    expect(detectLanguage("app.js")).toBe("javascript");
    expect(detectLanguage("comp.jsx")).toBe("javascript");
  });

  it("detects Python files", () => {
    expect(detectLanguage("main.py")).toBe("python");
  });

  it("returns null for unsupported extensions", () => {
    expect(detectLanguage("readme.md")).toBeNull();
    expect(detectLanguage("style.css")).toBeNull();
    expect(detectLanguage("config.yaml")).toBeNull();
  });
});

describe("parseSource — TypeScript", () => {
  it("parses a function declaration", () => {
    const src = `export function greet(name: string): string {\n  return "Hello " + name;\n}`;
    const result = parseSource("test.ts", src);
    expect(result).not.toBeNull();
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].name).toBe("greet");
    expect(result!.nodes[0].kind).toBe("function");
    expect(result!.nodes[0].signature).toContain("greet");
  });

  it("parses an async function", () => {
    const src = `export async function fetchData(url: string): Promise<string> {\n  return "";\n}`;
    const result = parseSource("test.ts", src);
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].name).toBe("fetchData");
  });

  it("parses a class with methods", () => {
    const src = [
      "export class UserService {",
      "  async getUser(id: string): Promise<User> {",
      "    return {} as User;",
      "  }",
      "  deleteUser(id: string): void {",
      "    // noop",
      "  }",
      "}",
    ].join("\n");
    const result = parseSource("test.ts", src);
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].name).toBe("UserService");
    expect(result!.nodes[0].kind).toBe("class");
    expect(result!.nodes[0].children.length).toBeGreaterThanOrEqual(2);
    expect(result!.nodes[0].children[0].kind).toBe("method");
  });

  it("parses an interface", () => {
    const src = `export interface Config {\n  host: string;\n  port: number;\n}`;
    const result = parseSource("test.ts", src);
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].name).toBe("Config");
    expect(result!.nodes[0].kind).toBe("interface");
  });

  it("parses a type alias", () => {
    const src = `export type ID = string;`;
    const result = parseSource("test.ts", src);
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].name).toBe("ID");
    expect(result!.nodes[0].kind).toBe("type");
  });

  it("parses arrow function consts", () => {
    const src = `export const handler = (req: Request): Response => {\n  return new Response();\n};`;
    const result = parseSource("test.ts", src);
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].name).toBe("handler");
    expect(result!.nodes[0].kind).toBe("function");
  });

  it("captures JSDoc comments", () => {
    const src = [
      "/** Greets someone. */",
      "export function greet(name: string): string {",
      '  return "hi";',
      "}",
    ].join("\n");
    const result = parseSource("test.ts", src);
    expect(result!.nodes[0].docstring).toContain("Greets someone");
  });

  it("handles multiple constructs in one file", () => {
    const src = [
      "export interface Opts { x: number; }",
      "export function run(o: Opts): void {",
      "  console.log(o);",
      "}",
      "export class Runner {",
      "  start(): void {",
      "    // ...",
      "  }",
      "}",
    ].join("\n");
    const result = parseSource("test.ts", src);
    expect(result!.nodes.length).toBeGreaterThanOrEqual(3);
  });

  it("returns totalLines", () => {
    const src = "line1\nline2\nline3";
    const result = parseSource("test.ts", src);
    expect(result!.totalLines).toBe(3);
  });

  it("returns null for unsupported files", () => {
    expect(parseSource("readme.md", "# Hello")).toBeNull();
  });
});

describe("parseSource — Python", () => {
  it("parses a top-level function", () => {
    const src = `def greet(name: str) -> str:\n    return f"Hello {name}"`;
    const result = parseSource("test.py", src);
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].name).toBe("greet");
    expect(result!.nodes[0].kind).toBe("function");
    expect(result!.nodes[0].signature).toContain("-> str");
  });

  it("parses a class with methods", () => {
    const src = [
      "class UserService:",
      '    """User operations."""',
      "    def get_user(self, uid: str) -> dict:",
      "        return {}",
      "    def delete_user(self, uid: str) -> None:",
      "        pass",
    ].join("\n");
    const result = parseSource("test.py", src);
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].name).toBe("UserService");
    expect(result!.nodes[0].kind).toBe("class");
    expect(result!.nodes[0].children.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts docstrings", () => {
    const src = ["class Foo:", '    """This is a docstring."""', "    pass"].join("\n");
    const result = parseSource("test.py", src);
    expect(result!.nodes[0].docstring).toBe("This is a docstring.");
  });

  it("parses async functions", () => {
    const src = "async def fetch(url: str) -> str:\n    return ''";
    const result = parseSource("test.py", src);
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].name).toBe("fetch");
  });
});

describe("parseSource — JavaScript", () => {
  it("parses JS functions", () => {
    const src = `function add(a, b) {\n  return a + b;\n}`;
    const result = parseSource("test.js", src);
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].name).toBe("add");
    expect(result!.language).toBe("javascript");
  });
});

describe("summarizeNode", () => {
  it("generates a concise summary", () => {
    const node: ASTNode = {
      name: "greet",
      kind: "function",
      startLine: 1,
      endLine: 3,
      source: 'function greet(name) { return "hi " + name; }',
      signature: "greet(name: string): string",
      docstring: "Greets a person.",
      children: [],
    };
    const summary = summarizeNode(node);
    expect(summary).toContain("function greet");
    expect(summary).toContain("Greets a person");
  });

  it("includes method names for classes", () => {
    const node: ASTNode = {
      name: "Svc",
      kind: "class",
      startLine: 1,
      endLine: 10,
      source: "class Svc { ... }",
      signature: "class Svc",
      docstring: null,
      children: [
        {
          name: "run",
          kind: "method",
          startLine: 2,
          endLine: 4,
          source: "",
          signature: "run()",
          docstring: null,
          children: [],
        },
        {
          name: "stop",
          kind: "method",
          startLine: 5,
          endLine: 7,
          source: "",
          signature: "stop()",
          docstring: null,
          children: [],
        },
      ],
    };
    const summary = summarizeNode(node);
    expect(summary).toContain("Methods: run, stop");
  });
});
