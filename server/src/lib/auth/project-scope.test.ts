/**
 * Issue #1066 — semantics of the canonical workspace-visibility predicate.
 *
 * These tests deliberately EVALUATE the returned Prisma fragment against rows
 * rather than only asserting its shape. A shape assertion is what let the old
 * `workspaceScopeFilter` comment ("match nothing") sit on top of a fragment
 * that actually matched every open project: nothing in the suite ever asked
 * what the fragment MEANT. `matchesScope` below is a faithful (tiny) model of
 * how Prisma evaluates these two clause forms, so a future edit that changes
 * the meaning fails here even if the shape still looks plausible.
 */
import { describe, expect, it } from "vitest";
import { workspaceScopeWhere, type WorkspaceScopeWhere } from "./project-scope.js";

interface Row {
  id: string;
  workspaceId: string | null;
}

const OPEN: Row = { id: "legacy-open", workspaceId: null };
const IN_WS1: Row = { id: "p-ws1", workspaceId: "ws-1" };
const IN_WS2: Row = { id: "p-ws2", workspaceId: "ws-2" };
const ALL_ROWS: Row[] = [OPEN, IN_WS1, IN_WS2];

/**
 * Minimal model of Prisma's evaluation of the fragments this module emits:
 * `{}` matches every row; `{ workspaceId: null }` matches rows whose column IS
 * NULL (it is NOT a "match nothing" sentinel); `{ workspaceId: { in: [...] } }`
 * matches rows whose non-null column is listed (an empty `in` matches nothing).
 */
function matchesScope(where: WorkspaceScopeWhere, row: Row): boolean {
  if (!("OR" in where)) return true;
  return where.OR.some((clause) => {
    if (clause.workspaceId === null) return row.workspaceId === null;
    return row.workspaceId !== null && clause.workspaceId.in.includes(row.workspaceId);
  });
}

const visible = (where: WorkspaceScopeWhere): string[] =>
  ALL_ROWS.filter((row) => matchesScope(where, row)).map((r) => r.id);

describe("workspaceScopeWhere", () => {
  it("admins bypass scoping entirely (empty fragment matches every row)", () => {
    const where = workspaceScopeWhere({ role: "admin", workspaces: [] });
    expect(where).toEqual({});
    expect(visible(where)).toEqual(["legacy-open", "p-ws1", "p-ws2"]);
  });

  it("a member sees workspace-less open projects PLUS their own workspaces", () => {
    const where = workspaceScopeWhere({ role: "developer", workspaces: ["ws-1"] });
    expect(where).toEqual({
      OR: [{ workspaceId: null }, { workspaceId: { in: ["ws-1"] } }],
    });
    // The regression #1066 guards: open projects must NOT disappear for a user
    // who happens to have joined a workspace.
    expect(visible(where)).toEqual(["legacy-open", "p-ws1"]);
  });

  it("a member of several workspaces sees all of them plus open projects", () => {
    const where = workspaceScopeWhere({ role: "developer", workspaces: ["ws-1", "ws-2"] });
    expect(visible(where)).toEqual(["legacy-open", "p-ws1", "p-ws2"]);
  });

  it("a member-less user sees open projects and nothing else", () => {
    expect(visible(workspaceScopeWhere({ role: "developer", workspaces: [] }))).toEqual([
      "legacy-open",
    ]);
  });

  it("treats a missing `workspaces` array as no memberships", () => {
    const where = workspaceScopeWhere({ role: "developer" });
    expect(where).toEqual({ OR: [{ workspaceId: null }, { workspaceId: { in: [] } }] });
    expect(visible(where)).toEqual(["legacy-open"]);
  });

  it("treats a null `workspaces` value as no memberships", () => {
    expect(visible(workspaceScopeWhere({ role: "developer", workspaces: null }))).toEqual([
      "legacy-open",
    ]);
  });
});

describe("the Prisma semantics the old #1066 comment got wrong", () => {
  it("`{ workspaceId: null }` matches open projects — it is not a deny-all sentinel", () => {
    const legacyFragment = { OR: [{ workspaceId: null as null }] } satisfies WorkspaceScopeWhere;
    expect(visible(legacyFragment)).toEqual(["legacy-open"]);
    expect(visible(legacyFragment)).not.toEqual([]);
  });

  it("`{ workspaceId: { in: [] } }` is the fragment that really matches nothing", () => {
    const denyAll = { OR: [{ workspaceId: { in: [] } }] } satisfies WorkspaceScopeWhere;
    expect(visible(denyAll)).toEqual([]);
  });
});
