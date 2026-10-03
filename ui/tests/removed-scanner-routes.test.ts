/**
 * #803 — the AI bug scanner's pages are removed. Their old URLs must fall
 * through to the app's standard not-found page rather than crash or render
 * blank.
 *
 * Next.js sends any URL that matches no route to the **root**
 * `app/not-found.tsx` (its rendering is covered by `app-not-found.test.tsx`).
 * So the property to pin is on disk: no page serves these paths any more, and
 * no catch-all segment on the way down could swallow them instead.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP = path.resolve(__dirname, "../src/app");

/** Every route directory (relative to `app/`, `/`-separated) that has a page. */
function pageRoutes(dir = APP): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pageRoutes(full));
    else if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      out.push(path.relative(APP, dir).split(path.sep).join("/"));
    }
  }
  return out;
}

const PROJECT = "(authed)/projects/[id]";
const REMOVED = ["scans", "scans/[scanId]", "rule-sets", "repositories/[repoId]/scanner"];

describe("removed bug-scanner routes (#803)", () => {
  const routes = pageRoutes();

  it("finds the project pages it walks", () => {
    expect(routes).toContain(PROJECT);
    expect(routes).toContain(`${PROJECT}/repositories`);
  });

  it("serves no page at any removed scanner path", () => {
    for (const rel of REMOVED) expect(routes, rel).not.toContain(`${PROJECT}/${rel}`);
    expect(routes.filter((r) => /\/(scans|rule-sets|scanner)(\/|$)/.test(r))).toEqual([]);
  });

  it("has no catch-all segment that would swallow those paths", () => {
    const ancestors = ["", "(authed)", "(authed)/projects", PROJECT, `${PROJECT}/repositories`];
    for (const rel of ancestors) {
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
