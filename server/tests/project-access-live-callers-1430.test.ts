/**
 * Issue #1430 — every project guard calls the LIVE project-access seam.
 *
 * `assertProjectAccess` admits a soft-deleted project; `assertLiveProjectAccess`
 * answers it with the 404 of an unknown one for a non-admin. The route-level
 * matrix (`deleted-project-subtree-1430.sqlite.test.ts`) proves the chokepoint
 * and the row helpers end to end, but a body- or query-`projectId` guard in a
 * single route (jira, mcp, ai, the ACP handlers, …) could be switched back to
 * the plain variant with no behavioural test going red: every route test that
 * stubs the seam stubs both names alike.
 *
 * So this pins the caller set structurally: the only production modules that
 * may still call the plain variant are the two that refuse a soft-deleted
 * project in their own lookup immediately before the call. Adding a caller —
 * or reverting one of #1430's — fails here and names the file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

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

/** Lines of `source` that CALL `assertProjectAccess(` (comments ignored). */
function plainVariantCalls(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
    if (
      /(?<![\w.])assertProjectAccess\s*\(/.test(code) &&
      !/function\s+assertProjectAccess/.test(code)
    ) {
      lines.push(i + 1);
    }
  });
  return lines;
}

describe("#1430 — project guards use assertLiveProjectAccess", () => {
  it("detects a call and ignores comments and the definition", () => {
    expect(plainVariantCalls("  await assertProjectAccess(user, id);")).toEqual([1]);
    expect(plainVariantCalls(" * `assertProjectAccess(user, id)` in prose")).toEqual([]);
    expect(plainVariantCalls("// assertProjectAccess(user, id)")).toEqual([]);
    expect(plainVariantCalls("export async function assertProjectAccess(")).toEqual([]);
    expect(plainVariantCalls("await assertLiveProjectAccess(user, id);")).toEqual([]);
  });

  it("only the two self-checking modules call the plain variant", () => {
    const offenders: string[] = [];
    const seenAllowed = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split(sep).join("/");
      const calls = plainVariantCalls(readFileSync(file, "utf8"));
      if (calls.length === 0) continue;
      if (PLAIN_VARIANT_ALLOWED.has(rel)) seenAllowed.add(rel);
      else offenders.push(...calls.map((n) => `${rel}:${n}`));
    }
    expect(offenders).toEqual([]);
    // A stale allowlist entry would hide a future offender of the same name.
    expect([...seenAllowed].sort()).toEqual([...PLAIN_VARIANT_ALLOWED].sort());
  });
});
