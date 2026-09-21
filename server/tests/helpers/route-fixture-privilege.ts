/**
 * Issue #1058 (epic #1051) — detector for route fixtures that cannot fail an
 * authorization test *by construction*.
 *
 * Two suites in this repo were found unable to detect an authorization hole no
 * matter how broken the route was:
 *
 *   • `tests/import-routes.test.ts` mocked BOTH `requireAuth` and
 *     `requirePermission` as pass-throughs, so the entire authorization stack
 *     under test was replaced by `next()`;
 *   • `tests/async-routes.test.ts` only ever authenticated as `admin`, and
 *     `assertProjectAccess` short-circuits for system admins — so every
 *     cross-tenant path was skipped.
 *
 * Both were fixed, and nothing stopped the pattern from coming back. This
 * detector is the ratchet: a test file that replaces `requireAuth` with its own
 * stub must exercise at least one NON-admin caller, or be listed in the
 * reviewed baseline with a reason.
 *
 * DELIBERATE LIMITS. This is a heuristic over test source text, not a semantic
 * analysis, and it is scoped as narrowly as the failure mode allows:
 *
 *   • It only looks at files that mock `middleware/auth.js`. A test using the
 *     real auth stack cannot exhibit the defect.
 *   • It only asks whether a non-`admin` role literal appears anywhere in the
 *     file. That is a weak question, but it is the question the two incidents
 *     would have failed, and a stronger one (which caller reached which route?)
 *     cannot be answered from source text without becoming brittle.
 *   • Stubbing `requirePermission` alone is NOT flagged. Several object-level
 *     scope suites (`*.workspace-scope.test.ts`) stub the role layer on purpose,
 *     precisely so the object-level layer is what is under test. Flagging those
 *     would train people to game the list.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Recursively collect `*.test.ts` under `dir`. */
export function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTestFiles(full));
    else if (full.endsWith(".test.ts")) out.push(full);
  }
  return out.sort();
}

/** True when the file replaces the real `requireAuth` with its own stub. */
export function mocksAuthMiddleware(source: string): boolean {
  return /vi\.mock\(\s*["'][^"']*middleware\/auth\.js["']/.test(source);
}

/**
 * Every distinct `role: "<value>"` literal in the file — the callers the
 * fixture is capable of impersonating.
 */
export function rolesExercised(source: string): string[] {
  const roles = new Set<string>();
  for (const m of source.matchAll(/\brole:\s*["'`]([A-Za-z0-9_-]+)["'`]/g)) roles.add(m[1]);
  return [...roles].sort();
}

/** Why a fixture is considered privileged-only, or `null` if it is fine. */
export type PrivilegeVerdict = "no-role-literal" | "admin-only" | null;

export function classifyFixture(source: string): PrivilegeVerdict {
  if (!mocksAuthMiddleware(source)) return null;
  const roles = rolesExercised(source);
  if (roles.length === 0) return "no-role-literal";
  if (roles.every((r) => r === "admin")) return "admin-only";
  return null;
}

/** Repo-relative, POSIX-separated path, so the baseline is portable. */
export function toKey(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}
