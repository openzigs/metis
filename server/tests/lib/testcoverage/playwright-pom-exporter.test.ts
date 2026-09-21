/**
 * Playwright POM scaffold exporter tests — Epic #260 / issue #44.
 *
 * Validates:
 *   - a zip is always produced containing pages/, tests/ and playwright.config.ts
 *   - one Page Object class per feature/requirement group
 *   - one spec per suggestion mapping title+gwt+steps to a `test.skip(...)`
 *     so the suite LISTS but never executes
 *   - SECURITY: malicious titles / selectors / feature names cannot break out
 *     of the generated TypeScript string literals or template literals, and
 *     cannot inject path separators / traversal into emitted filenames
 *   - the generated TypeScript parses (typecheck-as-proxy for the live AC)
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import ts from "typescript";

import {
  exportSuggestionsToPlaywrightPom,
  type ExportableSuggestion,
} from "../../../src/lib/testcoverage/index.js";

const baseSuggestion = (overrides: Partial<ExportableSuggestion>): ExportableSuggestion => ({
  id: "s-1",
  title: "default",
  gwt: { given: ["a precondition"], when: ["an action"], then: ["an outcome"] },
  steps: [],
  mappedRequirementIds: ["REQ-1"],
  faithfulness: 0.9,
  lowConfidence: false,
  ...overrides,
});

async function unzip(data: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(data);
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out[name] = await entry.async("string");
  }
  return out;
}

/** Compile a single TS source string in isolation; returns syntactic diagnostics. */
function syntaxErrors(source: string): readonly ts.Diagnostic[] {
  const sf = ts.createSourceFile("scaffold.ts", source, ts.ScriptTarget.ES2022, true);
  return (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
}

/**
 * Collect the names of every called function in `source` (the callee identifier
 * of each `CallExpression`). Tokens that only appear inside string literals or
 * comments never become a `CallExpression`, so this proves an injected
 * `evilCode()` / `require(...)` did NOT become executable code.
 */
function calledFunctionNames(source: string): Set<string> {
  const sf = ts.createSourceFile("scaffold.ts", source, ts.ScriptTarget.ES2022, true);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) names.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

describe("exportSuggestionsToPlaywrightPom", () => {
  it("returns a zip with pages/, tests/ and a playwright.config.ts", async () => {
    const result = await exportSuggestionsToPlaywrightPom([
      baseSuggestion({ id: "s-a", title: "Sign in", tags: ["feature:auth"] }),
    ]);
    expect(result.kind).toBe("zip");
    expect(Buffer.isBuffer(result.data)).toBe(true);
    const files = await unzip(result.data);
    const names = Object.keys(files);
    expect(names).toContain("playwright.config.ts");
    expect(names.some((n) => n.startsWith("pages/"))).toBe(true);
    expect(names.some((n) => n.startsWith("tests/"))).toBe(true);
  });

  it("emits one Page Object class per feature group", async () => {
    const result = await exportSuggestionsToPlaywrightPom([
      baseSuggestion({ id: "s-a", title: "Sign in", tags: ["feature:auth"] }),
      baseSuggestion({ id: "s-b", title: "Sign out", tags: ["feature:auth"] }),
      baseSuggestion({ id: "s-c", title: "Add to cart", tags: ["feature:cart"] }),
    ]);
    const files = await unzip(result.data);
    const pages = Object.keys(files).filter((n) => n.startsWith("pages/"));
    expect(pages).toHaveLength(2);
    expect(pages.sort()).toEqual(["pages/AuthPage.ts", "pages/CartPage.ts"]);
    expect(files["pages/AuthPage.ts"]).toContain("export class AuthPage");
  });

  it("emits one spec per suggestion using test.skip so the suite lists but does not run", async () => {
    const result = await exportSuggestionsToPlaywrightPom([
      baseSuggestion({ id: "s-a", title: "Sign in", tags: ["feature:auth"] }),
      baseSuggestion({ id: "s-b", title: "Sign out", tags: ["feature:auth"] }),
    ]);
    const files = await unzip(result.data);
    const specs = Object.keys(files).filter((n) => n.startsWith("tests/"));
    // Both suggestions share feature:auth -> one spec file with two test.skip.
    expect(specs).toEqual(["tests/auth.spec.ts"]);
    const skipCount = (files["tests/auth.spec.ts"].match(/test\.skip\(/g) ?? []).length;
    expect(skipCount).toBe(2);
    // gwt content surfaces as comments/steps in the spec body
    const joined = Object.values(files).join("\n");
    expect(joined).toContain("a precondition");
    expect(joined).toContain("an action");
  });

  it("generated TypeScript is syntactically valid", async () => {
    const result = await exportSuggestionsToPlaywrightPom([
      baseSuggestion({
        id: "s-1",
        title: "Successful login flow",
        gwt: {
          given: ["a registered user"],
          when: ["they submit valid credentials"],
          then: ["they see the dashboard"],
        },
        tags: ["feature:auth"],
      }),
    ]);
    const files = await unzip(result.data);
    for (const [name, content] of Object.entries(files)) {
      const errs = syntaxErrors(content);
      expect(errs, `${name} should parse: ${errs.map((e) => e.messageText).join("; ")}`).toEqual(
        [],
      );
    }
  });

  it("SECURITY: a malicious title cannot break out of the generated string literal", async () => {
    const evil = '"); evilCode(); test("pwn';
    const result = await exportSuggestionsToPlaywrightPom([
      baseSuggestion({ id: "s-evil", title: evil, tags: ["feature:auth"] }),
    ]);
    const files = await unzip(result.data);
    // Every file parses (no premature literal termination) AND the injected
    // `evilCode()` never became an executable call — it lives inside a string
    // literal / comment only.
    for (const [name, content] of Object.entries(files)) {
      expect(syntaxErrors(content), `${name} must remain valid`).toEqual([]);
      expect(calledFunctionNames(content).has("evilCode"), `${name}: no evilCode call`).toBe(false);
    }
  });

  it("SECURITY: a template-literal injection in the title cannot interpolate env vars", async () => {
    const evil = "login ${process.env.SECRET} `+require('fs')+`";
    const result = await exportSuggestionsToPlaywrightPom([
      baseSuggestion({ id: "s-evil2", title: evil, tags: ["feature:auth"] }),
    ]);
    const files = await unzip(result.data);
    for (const [name, content] of Object.entries(files)) {
      expect(syntaxErrors(content), `${name} must remain valid`).toEqual([]);
      // No `require(...)` call and no `process.env` access executes — the
      // payload is inert text inside a double-quoted literal.
      const calls = calledFunctionNames(content);
      expect(calls.has("require"), `${name}: no require call`).toBe(false);
      // `${...}` interpolation never survives into a template literal.
      expect(content).not.toContain("${process.env.SECRET}");
    }
  });

  it("SECURITY: feature/title names cannot inject path separators or traversal into filenames", async () => {
    const result = await exportSuggestionsToPlaywrightPom([
      baseSuggestion({
        id: "s-trav",
        title: "../../etc/passwd",
        tags: ["feature:../../../evil"],
      }),
    ]);
    const files = await unzip(result.data);
    for (const name of Object.keys(files)) {
      expect(name).not.toContain("..");
      expect(name.replace(/^(pages|tests)\//, "")).not.toContain("/");
    }
  });

  it("produces safe PascalCase class names even from hostile feature names", async () => {
    const result = await exportSuggestionsToPlaywrightPom([
      baseSuggestion({ id: "s-x", title: "t", tags: ["feature:1 weird-name!@#"] }),
    ]);
    const files = await unzip(result.data);
    const pageFile = Object.entries(files).find(([n]) => n.startsWith("pages/"));
    expect(pageFile).toBeDefined();
    const classMatch = pageFile?.[1].match(/export class (\w+)/);
    expect(classMatch).toBeTruthy();
    // Class name must be a valid TS identifier (alnum, not starting with a digit).
    expect(classMatch?.[1]).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
  });

  it("handles an empty suggestion list by still emitting a config", async () => {
    const result = await exportSuggestionsToPlaywrightPom([]);
    const files = await unzip(result.data);
    expect(Object.keys(files)).toContain("playwright.config.ts");
  });

  it("renders explicit steps as comments in the spec body", async () => {
    const result = await exportSuggestionsToPlaywrightPom([
      baseSuggestion({
        id: "s-steps",
        title: "Checkout",
        tags: ["feature:cart"],
        steps: [
          { action: "click the cart icon", expected: "cart opens" },
          { action: "press checkout" },
        ],
      }),
    ]);
    const files = await unzip(result.data);
    const joined = Object.values(files).join("\n");
    expect(joined).toContain("Step: click the cart icon");
    expect(joined).toContain("Step: press checkout");
  });

  it("de-duplicates method names when two suggestions share a title", async () => {
    const result = await exportSuggestionsToPlaywrightPom([
      baseSuggestion({ id: "s-1", title: "Login", tags: ["feature:auth"] }),
      baseSuggestion({ id: "s-2", title: "login", tags: ["feature:auth"] }),
    ]);
    const files = await unzip(result.data);
    const page = files["pages/AuthPage.ts"];
    // Both suggestions normalise to the same method base -> second is suffixed.
    expect(page).toContain("async login(");
    expect(page).toContain("async login2(");
    for (const [name, content] of Object.entries(files)) {
      expect(syntaxErrors(content), `${name} valid`).toEqual([]);
    }
  });

  it("de-duplicates page class names when two features slugify identically", async () => {
    const result = await exportSuggestionsToPlaywrightPom([
      baseSuggestion({ id: "s-1", title: "a", tags: ["feature:Check Out"] }),
      baseSuggestion({ id: "s-2", title: "b", tags: ["feature:check-out"] }),
    ]);
    const files = await unzip(result.data);
    const pages = Object.keys(files).filter((n) => n.startsWith("pages/"));
    // Two distinct page files even though both -> "CheckOutPage" / "check-out".
    expect(pages).toHaveLength(2);
    expect(new Set(pages).size).toBe(2);
  });
});
