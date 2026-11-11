/** #2238 — the chat scope as a key, and the scope a session searches. */
import { describe, expect, it } from "vitest";
import { scopeKeyOf, scopeOfSession, scopeSearches } from "./chat-scope";

describe("scopeKeyOf", () => {
  it("keys a scope on what it searches, whatever the order of its projects", () => {
    expect(scopeKeyOf({ mode: "all", projectIds: [] })).toBe("all");
    expect(scopeKeyOf({ mode: "selected", projectIds: [] })).toBe("all");
    expect(scopeKeyOf({ mode: "selected", projectIds: ["b", "a"] })).toBe("selected:a,b");
    expect(scopeKeyOf({ mode: "workspace", projectIds: [], workspaceId: "w" })).toBe("workspace:w");
  });

  it("does not reorder the scope it was handed", () => {
    const ids = ["b", "a"];
    scopeKeyOf({ mode: "selected", projectIds: ids });
    expect(ids).toEqual(["b", "a"]);
  });
});

describe("scopeOfSession", () => {
  it("reads a single-project, multi-product, workspace and unscoped session", () => {
    expect(scopeOfSession({ projectId: "p" })).toEqual({ mode: "selected", projectIds: ["p"] });
    expect(scopeOfSession({ projectId: null, scopeProjectIds: ["a", "b"] })).toEqual({
      mode: "selected",
      projectIds: ["a", "b"],
    });
    expect(scopeOfSession({ projectId: null, scopeWorkspaceId: "w" })).toEqual({
      mode: "workspace",
      projectIds: [],
      workspaceId: "w",
    });
    expect(scopeOfSession({ projectId: null, scopeProjectIds: [] })).toEqual({
      mode: "all",
      projectIds: [],
    });
  });
});

describe("scopeSearches", () => {
  it("is false only for 'All projects'", () => {
    expect(scopeSearches({ mode: "all", projectIds: [] })).toBe(false);
    expect(scopeSearches({ mode: "selected", projectIds: ["a"] })).toBe(true);
    expect(scopeSearches({ mode: "selected", projectIds: ["a", "b"] })).toBe(true);
    expect(scopeSearches({ mode: "workspace", projectIds: [], workspaceId: "w" })).toBe(true);
  });
});
