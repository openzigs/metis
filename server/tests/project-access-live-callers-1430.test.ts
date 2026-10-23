/**
 * Issue #1430 — every project guard uses the LIVE project-access seam.
 *
 * `assertProjectAccess` admits a soft-deleted project; `assertLiveProjectAccess`
 * answers it with the 404 of an unknown one for a non-admin. The route-level
 * matrix (`deleted-project-subtree-1430.sqlite.test.ts`) proves the chokepoint
 * and the row helpers end to end, but a body- or query-`projectId` guard in a
 * single route (jira, mcp, ai, the ACP handlers, …) could be switched back to
 * the plain variant with no behavioural test going red: every route test that
 * stubs the seam stubs both names alike.
 *
 * So this pins the plain variant's reach structurally. Outside the module that
 * defines it, the only production modules that may NAME it at all — import it
 * (aliased or not, statically or dynamically), re-export it, reach it through a
 * namespace import, or call it — are the two that refuse a soft-deleted project
 * in their own lookup immediately before the call. Matching the identifier
 * rather than call sites is what catches `import { assertProjectAccess as
 * assertLiveProjectAccess }`, whose calls all read like the live variant.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Where the plain variant is defined. */
const DEFINITION = "lib/custom-agents/authz.ts";

/** Each refuses a soft-deleted project itself, just before the call. */
const PLAIN_VARIANT_ALLOWED = new Set([
  // `canAccessProjectDiscussions`: `deletedAt: null` lookup for non-admins.
  "lib/discussions/access.ts",
  // `deletedAt: null` lookup for everyone, admins included.
  "lib/docs-gen/evidence-policy.ts",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Blank out comments, keeping line breaks so line numbers survive. Line
 * comments are taken only where `//` is not part of a `://` URL.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 1-based lines whose CODE names the plain `assertProjectAccess`. */
function plainVariantReferences(source: string): number[] {
  const lines: number[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, i) => {
      if (/\bassertProjectAccess\b/.test(line)) lines.push(i + 1);
    });
  return lines;
}

describe("#1430 — project guards use assertLiveProjectAccess", () => {
  it("flags every form of reference, and ignores comments and the live name", () => {
    const flagged = (src: string) => plainVariantReferences(src).length > 0;
    expect(flagged("  await assertProjectAccess(user, id);")).toBe(true);
    expect(flagged('import { assertProjectAccess } from "../custom-agents/authz.js";')).toBe(true);
    expect(
      flagged('import { assertProjectAccess as assertLiveProjectAccess } from "../x/authz.js";'),
    ).toBe(true);
    expect(flagged("import {\n  foo,\n  assertProjectAccess as check,\n} from './authz.js';")).toBe(
      true,
    );
    expect(flagged('const { assertProjectAccess: c } = await import("./authz.js");')).toBe(true);
    expect(flagged("await authz.assertProjectAccess(user, id);")).toBe(true);
    expect(flagged('export { assertProjectAccess } from "./authz.js";')).toBe(true);
    expect(flagged("/**\n * `assertProjectAccess(user, id)` in prose\n */")).toBe(false);
    expect(flagged("// assertProjectAccess(user, id)")).toBe(false);
    expect(flagged("foo(); // assertProjectAccess")).toBe(false);
    expect(flagged("/* assertProjectAccess */ foo();")).toBe(false);
    expect(flagged('const u = "https://x"; await assertProjectAccess(u, id);')).toBe(true);
    expect(flagged("await assertLiveProjectAccess(user, id);")).toBe(false);
    expect(
      plainVariantReferences("a\n/*\n assertProjectAccess\n*/\nassertProjectAccess();"),
    ).toEqual([5]);
  });

  it("only the two self-checking modules name the plain variant", () => {
    const offenders: string[] = [];
    const seenAllowed = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split(sep).join("/");
      if (rel === DEFINITION) continue;
      const refs = plainVariantReferences(readFileSync(file, "utf8"));
      if (refs.length === 0) continue;
      if (PLAIN_VARIANT_ALLOWED.has(rel)) seenAllowed.add(rel);
      else offenders.push(...refs.map((n) => `${rel}:${n}`));
    }
    expect(offenders).toEqual([]);
    // A stale allowlist entry would hide a future offender of the same name.
    expect([...seenAllowed].sort()).toEqual([...PLAIN_VARIANT_ALLOWED].sort());
  });
});
