/**
 * #818 — the Test Coverage page and its test-management connections page are
 * removed. Their old URLs must fall through to the app's standard not-found
 * page — no redirect (epic #812, open question 7).
 *
 * Next.js sends any URL that matches no route to the **root**
 * `app/not-found.tsx` (its rendering is covered by `app-not-found.test.tsx`).
 * So the property to pin is on disk: no page or route handler serves these
 * paths any more, and no catch-all segment on the way down could swallow them.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP = path.resolve(__dirname, "../src/app");

/** Every route directory (relative to `app/`, `/`-separated) with a page or handler. */
function routeDirs(dir = APP): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeDirs(full));
    else if (/^(page|route)\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      out.push(path.relative(APP, dir).split(path.sep).join("/"));
    }
  }
  return out;
}

const PROJECT = "(authed)/projects/[id]";

describe("removed Test Coverage routes (#818)", () => {
  const routes = routeDirs();

  it("finds the project pages it walks", () => {
    expect(routes).toContain(PROJECT);
    expect(routes).toContain(`${PROJECT}/pulls`);
  });

  it("serves nothing at /test-coverage or /test-coverage/connections", () => {
    expect(routes).not.toContain(`${PROJECT}/test-coverage`);
    expect(routes).not.toContain(`${PROJECT}/test-coverage/connections`);
    expect(routes.filter((r) => /(^|\/)test-coverage(\/|$)/.test(r))).toEqual([]);
  });

  it("has no catch-all segment that would swallow those paths", () => {
    for (const rel of ["", "(authed)", "(authed)/projects", PROJECT]) {
      const dirs = fs
        .readdirSync(path.join(APP, rel), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      expect(
        dirs.filter((d) => d.startsWith("[...") || d.startsWith("[[...")),
        rel,
      ).toEqual([]);
    }
  });

  it("keeps the root not-found page that unmatched URLs render", () => {
    expect(fs.existsSync(path.join(APP, "not-found.tsx"))).toBe(true);
  });
});
