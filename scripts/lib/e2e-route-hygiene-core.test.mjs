import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { routeCallsWithTimes, unrouteCalls } from "./e2e-route-hygiene-core.mjs";

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

  // Review of PR #326: a hand-written string/comment blanker read the quote in
  // `/'/` as an opening string and hid every later call in the file.
  it("still sees a call after a regex literal that contains a quote", () => {
    const src = 'const r = /\'/;\nawait page.route("**/a", h, { times: 1 });';
    expect(routeCallsWithTimes(src)).toEqual([2]);
  });

  it("sees a call inside a template-literal substitution", () => {
    const src = "const s = `${await page.route('**/a', h, { times: 1 })}`;";
    expect(routeCallsWithTimes(src)).toEqual([1]);
  });

  it('flags the `{ times }` shorthand and a quoted `"times"` key', () => {
    const src =
      "await page.route('**/a', h, { times });\nawait page.route('**/b', h, { \"times\": 1 });";
    expect(routeCallsWithTimes(src)).toEqual([1, 2]);
  });

  it("parses JSX in a .tsx file", () => {
    const src = "const el = <div a='x' />;\nawait page.route('**/a', h, { times: 1 });";
    expect(routeCallsWithTimes(src, "c.tsx")).toEqual([2]);
  });
});

describe("unrouteCalls (#327)", () => {
  it("flags page.unroute, context.unroute and unrouteAll with or without options", () => {
    const src = [
      "await page.unroute('**/a', h);",
      "await context.unroute(/github/, sentinel);",
      "await page.unrouteAll();",
      'await page.unrouteAll({ behavior: "wait" });',
    ].join("\n");
    expect(unrouteCalls(src)).toEqual([1, 2, 3, 4]);
  });

  it("passes route, fallback and a flag that disarms a route", () => {
    const src = [
      "let armed = true;",
      "await page.route('**/a', (r) => (armed ? r.abort() : r.fallback()));",
      "armed = false;",
    ].join("\n");
    expect(unrouteCalls(src)).toEqual([]);
  });

  it("ignores the words in strings, comments and a bare identifier", () => {
    const src = [
      "// page.unroute('**/a') would strand the next request",
      "const s = 'page.unrouteAll()';",
      "const unroute = 1;",
      "unrouteAll();",
    ].join("\n");
    expect(unrouteCalls(src)).toEqual([]);
  });

  it("parses JSX in a .tsx file", () => {
    const src = "const el = <div a='x' />;\nawait page.unrouteAll();";
    expect(unrouteCalls(src, "c.tsx")).toEqual([2]);
  });
});

describe("the e2e suite (#297, #327)", () => {
  const e2eRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "e2e");

  /** @param {string} dir @returns {string[]} */
  const tsFiles = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : tsFiles(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });

  it("scans real spec files", () => {
    expect(tsFiles(path.join(e2eRoot, "tests")).length).toBeGreaterThan(50);
  });

  it("has no route with a `times` option — it can strand the page's next request", () => {
    const offenders = ["tests", "pages", "fixtures"].flatMap((dir) =>
      tsFiles(path.join(e2eRoot, dir)).flatMap((file) =>
        routeCallsWithTimes(fs.readFileSync(file, "utf8"), file).map(
          (line) => `${path.relative(e2eRoot, file)}:${line}`,
        ),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("has no unroute / unrouteAll — removing the last route can strand the page's next request", () => {
    const offenders = ["tests", "pages", "fixtures"].flatMap((dir) =>
      tsFiles(path.join(e2eRoot, dir)).flatMap((file) =>
        unrouteCalls(fs.readFileSync(file, "utf8"), file).map(
          (line) => `${path.relative(e2eRoot, file)}:${line}`,
        ),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
