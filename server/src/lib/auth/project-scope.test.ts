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
  /** User ids holding a membership row in the project's workspace. */
  members: string[];
}

const U = "user-1";
const OPEN: Row = { id: "legacy-open", workspaceId: null, members: [] };
const IN_WS1: Row = { id: "p-ws1", workspaceId: "ws-1", members: [U] };
const IN_WS2: Row = { id: "p-ws2", workspaceId: "ws-2", members: [U] };
const ALL_ROWS: Row[] = [OPEN, IN_WS1, IN_WS2];

/**
 * Minimal model of Prisma's evaluation of the fragments this module emits:
 * `{}` matches every row; `{ workspaceId: null }` matches rows whose column IS
 * NULL (it is NOT a "match nothing" sentinel); `{ workspaceId: { in: [...] } }`
 * matches rows whose non-null column is listed (an empty `in` matches nothing),
 * and — when the clause carries `workspace.members.some` — whose workspace still
 * holds that user's membership row (#561).
 */
function matchesScope(where: WorkspaceScopeWhere, row: Row): boolean {
  if (!("OR" in where)) return true;
  return where.OR.some((clause) => {
    if (clause.workspaceId === null) return row.workspaceId === null;
    const memberId = clause.workspace?.members?.some.userId;
    return (
      row.workspaceId !== null &&
      clause.workspaceId.in.includes(row.workspaceId) &&
      (memberId === undefined || row.members.includes(memberId))
    );
  });
}

const visible = (where: WorkspaceScopeWhere, rows: Row[] = ALL_ROWS): string[] =>
  rows.filter((row) => matchesScope(where, row)).map((r) => r.id);

const LIVE_MEMBER = { deletedAt: null, members: { some: { userId: U } } } as const;

describe("workspaceScopeWhere", () => {
  it("admins bypass scoping entirely (empty fragment matches every row)", () => {
    const where = workspaceScopeWhere({ userId: U, role: "admin", workspaces: [] });
    expect(where).toEqual({});
    expect(visible(where)).toEqual(["legacy-open", "p-ws1", "p-ws2"]);
  });

  it("a member sees workspace-less open projects PLUS their own workspaces", () => {
    const where = workspaceScopeWhere({ userId: U, role: "developer", workspaces: ["ws-1"] });
    expect(where).toEqual({
      OR: [{ workspaceId: null }, { workspaceId: { in: ["ws-1"] }, workspace: LIVE_MEMBER }],
    });
    // The regression #1066 guards: open projects must NOT disappear for a user
    // who happens to have joined a workspace.
    expect(visible(where)).toEqual(["legacy-open", "p-ws1"]);
  });

  it("a member of several workspaces sees all of them plus open projects", () => {
    const where = workspaceScopeWhere({
      userId: U,
      role: "developer",
      workspaces: ["ws-1", "ws-2"],
    });
    expect(visible(where)).toEqual(["legacy-open", "p-ws1", "p-ws2"]);
  });

  it("a member-less user sees open projects and nothing else", () => {
    expect(visible(workspaceScopeWhere({ userId: U, role: "developer", workspaces: [] }))).toEqual([
      "legacy-open",
    ]);
  });

  it("treats a missing `workspaces` array as no memberships", () => {
    const where = workspaceScopeWhere({ userId: U, role: "developer" });
    expect(where).toEqual({
      OR: [{ workspaceId: null }, { workspaceId: { in: [] }, workspace: LIVE_MEMBER }],
    });
    expect(visible(where)).toEqual(["legacy-open"]);
  });

  it("treats a null `workspaces` value as no memberships", () => {
    expect(
      visible(workspaceScopeWhere({ userId: U, role: "developer", workspaces: null })),
    ).toEqual(["legacy-open"]);
  });
});

describe("#561 — a claim that outlived a removal", () => {
  it("a removed member whose claim still names the workspace sees open projects only", () => {
    const removed: Row = { id: "p-ws1-removed", workspaceId: "ws-1", members: [] };
    const where = workspaceScopeWhere({ userId: U, role: "developer", workspaces: ["ws-1"] });
    expect(visible(where, [OPEN, removed, IN_WS1])).toEqual(["legacy-open", "p-ws1"]);
  });

  it("matches the membership row on THIS actor, not on any member", () => {
    const where = workspaceScopeWhere({
      userId: "someone-else",
      role: "developer",
      workspaces: ["ws-1"],
    });
    expect(visible(where)).toEqual(["legacy-open"]);
  });
});

describe("the Prisma semantics the old #1066 comment got wrong", () => {
  it("`{ workspaceId: null }` matches open projects — it is not a deny-all sentinel", () => {
    const legacyFragment = { OR: [{ workspaceId: null as null }] } satisfies WorkspaceScopeWhere;
    expect(visible(legacyFragment)).toEqual(["legacy-open"]);
    expect(visible(legacyFragment)).not.toEqual([]);
  });

  it("`{ workspaceId: { in: [] } }` is the fragment that really matches nothing", () => {
    const denyAll = {
      OR: [{ workspaceId: { in: [] }, workspace: LIVE_MEMBER }],
    } satisfies WorkspaceScopeWhere;
    expect(visible(denyAll)).toEqual([]);
  });
});
