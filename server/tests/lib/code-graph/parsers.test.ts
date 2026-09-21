/**
 * Issue #308 — Per-language parser tests. Covers TS/JS/Python/Go/Java
 * + the `detectLanguage` dispatcher.
 */
import { describe, it, expect } from "vitest";
import { detectLanguage, parseSource } from "../../../src/lib/code-graph/parsers.js";

describe("detectLanguage", () => {
  it.each([
    ["foo.ts", "ts"],
    ["foo.tsx", "ts"],
    ["foo.mts", "ts"],
    ["foo.js", "js"],
    ["foo.jsx", "js"],
    ["foo.py", "py"],
    ["foo.go", "go"],
    ["Foo.java", "java"],
  ])("%s -> %s", (file, expected) => {
    expect(detectLanguage(file)).toBe(expected);
  });

  it("returns null for unknown extensions", () => {
    expect(detectLanguage("foo.rs")).toBeNull();
    expect(detectLanguage("Makefile")).toBeNull();
  });
});

describe("TypeScript parser", () => {
  const src = `// imports
import { foo } from "./foo";
import type { Bar } from "./types";

/**
 * Top-level helper.
 */
export function add(a: number, b: number): number {
  return a + b;
}

// WHY: keeps the API surface small
export class Calculator {
  square(x: number): number {
    return x * x;
  }
}

export interface Shape {
  area: number;
}

export type ID = string;

const arrow = (n: number) => add(n, 1);

function caller() {
  return add(1, 2);
}
`;

  const result = parseSource("src/x.ts", src, "ts");

  it("emits a module symbol", () => {
    expect(result.symbols.find((s) => s.kind === "module")).toBeDefined();
  });

  it("captures functions, classes, interfaces, types", () => {
    const kinds = result.symbols.map((s) => s.kind);
    expect(kinds).toContain("function");
    expect(kinds).toContain("class");
    expect(kinds).toContain("interface");
    expect(kinds).toContain("type");
  });

  it("captures arrow-function assignments as functions", () => {
    expect(result.symbols.find((s) => s.name === "arrow" && s.kind === "function")).toBeDefined();
  });

  it("emits one defines edge per non-module symbol", () => {
    const defs = result.edges.filter((e) => e.kind === "defines");
    expect(defs.length).toBeGreaterThanOrEqual(5);
  });

  it("emits import edges and flags type-only imports", () => {
    const imports = result.edges.filter((e) => e.kind === "imports");
    expect(imports.length).toBe(2);
    const typeOnly = imports.find((e) => e.toQualifiedName === "./types");
    expect(typeOnly?.metadata).toEqual({ typeOnly: true });
  });

  it("emits call edges and attributes them to the enclosing function", () => {
    const callerCall = result.edges.find(
      (e) => e.kind === "calls" && e.fromQualifiedName.endsWith("::caller"),
    );
    expect(callerCall).toBeDefined();
    expect(callerCall?.toQualifiedName).toBe("add");
  });

  it("captures JSDoc and WHY-marker rationale hints", () => {
    expect(result.rationaleHints.find((h) => h.tag === "JSDOC")).toBeDefined();
    expect(result.rationaleHints.find((h) => h.tag === "WHY")).toBeDefined();
  });
});

describe("JavaScript parser", () => {
  it("treats .js the same as .ts but without the type keyword", () => {
    const src = `function f() { g(); }\nfunction g() {}\n`;
    const result = parseSource("a.js", src, "js");
    expect(result.symbols.filter((s) => s.kind === "function")).toHaveLength(2);
    expect(result.edges.find((e) => e.kind === "calls")).toBeDefined();
  });
});

describe("Python parser", () => {
  const src = `import os
from typing import Optional

# WHY: bootstrap the registry
def setup():
    """Set up the registry."""
    return register("default")

class Registry:
    def register(self, name):
        # NOTE: idempotent
        return name

def register(name):
    return name
`;
  const result = parseSource("svc/x.py", src, "py");

  it("captures def and class", () => {
    expect(result.symbols.find((s) => s.kind === "function" && s.name === "setup")).toBeDefined();
    expect(result.symbols.find((s) => s.kind === "class" && s.name === "Registry")).toBeDefined();
  });

  it("captures import and from-import", () => {
    const imports = result.edges.filter((e) => e.kind === "imports");
    expect(imports.map((e) => e.toQualifiedName).sort()).toEqual(["os", "typing"]);
  });

  it("captures docstring as DOCSTRING hint and WHY/NOTE markers", () => {
    expect(result.rationaleHints.find((h) => h.tag === "DOCSTRING")).toBeDefined();
    expect(result.rationaleHints.find((h) => h.tag === "WHY")).toBeDefined();
    expect(result.rationaleHints.find((h) => h.tag === "NOTE")).toBeDefined();
  });

  it("call edges attribute to enclosing def", () => {
    const setupCall = result.edges.find(
      (e) => e.kind === "calls" && e.fromQualifiedName.endsWith("::setup"),
    );
    expect(setupCall?.toQualifiedName).toBe("register");
  });
});

describe("Go parser", () => {
  const src = `package main

import (
    "fmt"
    "os"
)

import "log"

// WHY: entrypoint hands off to run()
func main() {
    run()
}

func run() {
    fmt.Println("hi")
}

type Thing struct {
    name string
}

type Stringer interface {
    String() string
}
`;
  const result = parseSource("cmd/main.go", src, "go");

  it("captures funcs and types", () => {
    expect(result.symbols.find((s) => s.name === "main")).toBeDefined();
    expect(result.symbols.find((s) => s.name === "Thing" && s.kind === "class")).toBeDefined();
    expect(
      result.symbols.find((s) => s.name === "Stringer" && s.kind === "interface"),
    ).toBeDefined();
  });

  it("captures multi-line and single-line imports", () => {
    const targets = result.edges
      .filter((e) => e.kind === "imports")
      .map((e) => e.toQualifiedName)
      .sort();
    expect(targets).toEqual(["fmt", "log", "os"]);
  });

  it("captures WHY marker", () => {
    expect(result.rationaleHints.find((h) => h.tag === "WHY")).toBeDefined();
  });
});

describe("Java parser", () => {
  const src = `package com.example;

import java.util.List;
import java.io.*;

// WHY: keep dispatcher dumb
public class Dispatcher {
    public void dispatch(Event e) {
        handle(e);
    }

    private static String describe(Event e) {
        return e.toString();
    }
}

public interface Handler {
}
`;
  const result = parseSource("src/Dispatcher.java", src, "java");

  it("captures classes and interfaces", () => {
    expect(result.symbols.find((s) => s.name === "Dispatcher" && s.kind === "class")).toBeDefined();
    expect(
      result.symbols.find((s) => s.name === "Handler" && s.kind === "interface"),
    ).toBeDefined();
  });

  it("captures imports", () => {
    const targets = result.edges
      .filter((e) => e.kind === "imports")
      .map((e) => e.toQualifiedName)
      .sort();
    expect(targets).toEqual(["java.io.*", "java.util.List"]);
  });

  it("captures WHY marker", () => {
    expect(result.rationaleHints.find((h) => h.tag === "WHY")).toBeDefined();
  });
});
