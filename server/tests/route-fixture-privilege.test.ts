/**
 * Issue #1058 (epic #1051) — route fixtures must be *able* to fail.
 *
 * A guard is only as good as the suite that would notice it disappearing. Two
 * suites here could not have noticed, by construction:
 *
 *   • `tests/import-routes.test.ts` replaced `requireAuth` AND `requirePermission`
 *     with pass-throughs — the authorization stack under test was `next()`;
 *   • `tests/async-routes.test.ts` only authenticated as `admin`, and
 *     `assertProjectAccess` bypasses system admins, so every cross-tenant case
 *     was silently skipped.
 *
 * Both are fixed. This test stops the pattern returning: a fixture that stubs
 * `requireAuth` must exercise at least one non-admin caller, or be listed in
 * `helpers/route-fixture-privilege-baseline.ts` with a reason.
 *
 * The detector is deliberately narrow — see the header of
 * `helpers/route-fixture-privilege.ts` for exactly what it does and does not
 * claim, and why stubbing `requirePermission` alone is intentionally allowed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyFixture,
  collectTestFiles,
  mocksAuthMiddleware,
  rolesExercised,
  toKey,
} from "./helpers/route-fixture-privilege.js";
import { ROUTE_FIXTURE_BASELINE } from "./helpers/route-fixture-privilege-baseline.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_ROOTS = ["tests", "src/routes"].map((d) =>
  fileURLToPath(new URL(`../${d}`, import.meta.url)),
);

const flagged = SCAN_ROOTS.flatMap(collectTestFiles)
  .map((file) => ({
    key: toKey(SERVER_ROOT, file),
    verdict: classifyFixture(readFileSync(file, "utf8")),
  }))
  .filter((r) => r.verdict !== null);

const baselineKeys = new Set(ROUTE_FIXTURE_BASELINE.map((e) => e.file));

describe("privileged-only route fixtures", () => {
  it("scans a meaningful number of test files", () => {
    const scanned = SCAN_ROOTS.flatMap(collectTestFiles);
    expect(scanned.length).toBeGreaterThan(100);
    expect(
      scanned.filter((f) => mocksAuthMiddleware(readFileSync(f, "utf8"))).length,
    ).toBeGreaterThan(10);
  });

  it("has no new fixture that cannot detect an authorization hole", () => {
    const offenders = flagged
      .filter((r) => !baselineKeys.has(r.key))
      .map(
        (r) =>
          `  server/${r.key}  (${r.verdict})\n` +
          `    → this suite stubs requireAuth and ${
            r.verdict === "admin-only"
              ? "only ever authenticates as `admin`, who bypasses assertProjectAccess"
              : "never sets a role at all"
          }, so an object-level authorization hole in the routes it covers would not fail it.\n` +
          `    → fix: add at least one case authenticating as a non-admin caller ` +
          `(e.g. \`{ userId: "u", role: "reader", workspaces: ["ws-other"] }\`) and assert the 403/404. ` +
          `Reference: server/src/routes/hooks.test.ts:87.`,
      );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `\n${offenders.length} route fixture(s) cannot detect an authorization hole:\n\n` +
            `${offenders.join("\n\n")}\n\n` +
            `Do NOT silence this by appending to tests/helpers/route-fixture-privilege-baseline.ts ` +
            `— that list is a shrinking record of pre-existing debt.\n`,
    ).toEqual([]);
  });

  it("has no baseline entry that is already fixed (the list may only shrink)", () => {
    const flaggedKeys = new Set(flagged.map((r) => r.key));
    const stale = [...baselineKeys].filter((k) => !flaggedKeys.has(k));
    expect(
      stale,
      stale.length === 0
        ? ""
        : `\nThese fixtures no longer match the detector — either they now exercise a ` +
            `non-admin caller (thank you) or they were deleted/renamed. Remove their ` +
            `entries from tests/helpers/route-fixture-privilege-baseline.ts:\n  ${stale.join("\n  ")}\n`,
    ).toEqual([]);
  });

  it("gives every baseline entry a written reason", () => {
    for (const entry of ROUTE_FIXTURE_BASELINE) {
      expect(entry.note.trim().length, `${entry.file} needs a reason`).toBeGreaterThan(20);
    }
  });
});

describe("privileged-fixture detector", () => {
  const authMock = 'vi.mock("../middleware/auth.js", () => ({}));';

  it("ignores a suite that uses the real auth middleware", () => {
    expect(classifyFixture('role: "admin"')).toBeNull();
  });

  it("flags an auth-stubbing suite with no role at all", () => {
    expect(classifyFixture(authMock)).toBe("no-role-literal");
  });

  it("flags an auth-stubbing suite that only impersonates admin", () => {
    expect(classifyFixture(`${authMock}\nconst u = { role: "admin" };`)).toBe("admin-only");
  });

  it("accepts an auth-stubbing suite that also impersonates a non-admin", () => {
    expect(classifyFixture(`${authMock}\nrole: "admin"\nrole: "reader"`)).toBeNull();
  });

  it("recognises the auth mock through path and quote variations", () => {
    expect(mocksAuthMiddleware(`vi.mock('../../src/middleware/auth.js', () => ({}))`)).toBe(true);
    expect(mocksAuthMiddleware(`vi.mock(\n  "../src/middleware/auth.js",\n  () => ({}))`)).toBe(
      true,
    );
    expect(mocksAuthMiddleware(`vi.mock("../middleware/authz.js", () => ({}))`)).toBe(false);
  });

  it("collects distinct role literals across quote styles", () => {
    expect(rolesExercised(`role: "admin" role: 'reader' role: \`admin\``)).toEqual([
      "admin",
      "reader",
    ]);
  });
});
