import { describe, expect, it } from "vitest";
import { queryKeys } from "@/lib/query-keys";

describe("queryKeys", () => {
  it("namespaces every domain under a top-level array", () => {
    expect(queryKeys.auth.all).toEqual(["auth"]);
    expect(queryKeys.projects.all).toEqual(["projects"]);
    expect(queryKeys.documents.all).toEqual(["documents"]);
    expect(queryKeys.analyses.all).toEqual(["analyses"]);
    expect(queryKeys.issues.all).toEqual(["issues"]);
    expect(queryKeys.scheduler.all).toEqual(["scheduler"]);
    expect(queryKeys.admin.all).toEqual(["admin"]);
  });

  it("derives detail / list keys from the namespace prefix", () => {
    expect(queryKeys.projects.detail("p1")).toEqual(["projects", "detail", "p1"]);
    expect(queryKeys.projects.list({ status: "active" })).toEqual([
      "projects",
      "list",
      { status: "active" },
    ]);
    expect(queryKeys.documents.forProject("p1")).toEqual(["documents", "project", "p1"]);
    expect(queryKeys.scheduler.jobs()).toEqual(["scheduler", "jobs", {}]);
    expect(queryKeys.admin.audit()).toEqual(["admin", "audit"]);
  });

  it("uses an empty filter object when none provided", () => {
    expect(queryKeys.projects.list()).toEqual(["projects", "list", {}]);
  });
});
