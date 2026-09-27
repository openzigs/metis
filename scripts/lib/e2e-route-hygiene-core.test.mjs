import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { blankLiterals, callEnd, routeCallsWithTimes } from "./e2e-route-hygiene-core.mjs";

describe("routeCallsWithTimes (#297)", () => {
  it("flags a route call that passes { times }", () => {
    const src = [
      "await page.route(",
      "  (url) => url.pathname.endsWith(p),",
      "  async (route) => route.fulfill({ status: 409 }),",
      "  { times: 1 },",
      ");",
    ].join("\n");
    expect(routeCallsWithTimes(src)).toEqual([1]);
  });

  it("flags context.route and a times option spelled without spaces", () => {
    expect(routeCallsWithTimes("x;\nawait context.route('**/a', h, {times:2});")).toEqual([2]);
  });

  it("passes a route that stays registered", () => {
    const src = "await page.route((u) => u.pathname === '/a', async (r) => r.fallback());";
    expect(routeCallsWithTimes(src)).toEqual([]);
  });

  it("does not attribute a later `times:` outside the call to it", () => {
    const src = "await page.route('**/a', h);\nconst opts = { times: 3 };";
    expect(routeCallsWithTimes(src)).toEqual([]);
  });

  it("ignores parentheses and `times:` inside strings and comments", () => {
    const src = [
      "await page.route('**/a(', async (r) => {",
      "  // a ) paren and times: 1 in a comment",
      "  /* ) times: 2 */",
      '  const s = ") times: 3";',
      "  const t = `)` + '\\')';",
      "  return r.fallback();",
      "});",
      "const later = { times: 4 };",
    ].join("\n");
    expect(routeCallsWithTimes(src)).toEqual([]);
  });

  it("still scans an unterminated call to the end of the file", () => {
    expect(routeCallsWithTimes("page.route('**/a', h, { times: 1 }")).toEqual([1]);
  });
});

describe("callEnd", () => {
  it("returns the index just past the matching parenthesis", () => {
    expect(callEnd("f(a(b), c) + 1", 1)).toBe(10);
  });

  it("returns -1 for an unclosed call", () => {
    expect(callEnd("f(a, (b)", 1)).toBe(-1);
  });
});

describe("blankLiterals", () => {
  it("blanks string, template and comment bodies but keeps length and newlines", () => {
    const src = "a('x)') // c(\n/* (\n) */ `t(` + \"q)\"";
    const out = blankLiterals(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out.replace(/[\s]/g, "")).toBe("a('')``+\"\"");
  });

  it("keeps an escaped quote inside its string", () => {
    expect(blankLiterals("f('a\\')b')").replace(/ /g, "")).toBe("f('')");
  });

  it.each([
    ["an unterminated string", "f('abc"],
    ["an unterminated block comment", "f(/* abc"],
    ["an unterminated line comment", "f(// abc"],
  ])("blanks %s to the end of the source", (_label, src) => {
    expect(blankLiterals(src).trimEnd()).toMatch(/^f\('?$/);
  });
});

describe("the e2e suite (#297)", () => {
  const e2eRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "e2e");

  /** @param {string} dir @returns {string[]} */
  const tsFiles = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : tsFiles(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });

  it("scans real spec files", () => {
    expect(tsFiles(path.join(e2eRoot, "tests")).length).toBeGreaterThan(50);
  });

  it("has no route with a `times` option — it can strand the page's next request", () => {
    const offenders = ["tests", "pages", "fixtures"].flatMap((dir) =>
      tsFiles(path.join(e2eRoot, dir)).flatMap((file) =>
        routeCallsWithTimes(fs.readFileSync(file, "utf8")).map(
          (line) => `${path.relative(e2eRoot, file)}:${line}`,
        ),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
