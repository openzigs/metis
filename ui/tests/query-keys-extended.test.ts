/**
 * Issue #121 — extended query-keys coverage.
 * Calls every uncovered key function with and without optional params
 * to cover both branches of the `?? {}` / `?? default` fallbacks.
 */
import { describe, it, expect } from "vitest";
import { queryKeys } from "@/lib/query-keys";

describe("queryKeys — extended coverage", () => {
  // auth
  it("auth.me returns correct key", () => {
    expect(queryKeys.auth.me()).toEqual(["auth", "me"]);
  });

  // projects — uncovered keys
  it("projects.usage with and without window", () => {
    expect(queryKeys.projects.usage("p1")).toEqual(["projects", "usage", "p1", {}]);
    expect(queryKeys.projects.usage("p1", { from: "2026-01-01" })).toEqual([
      "projects",
      "usage",
      "p1",
      { from: "2026-01-01" },
    ]);
  });
  it("projects.safetyEvents with and without filters", () => {
    expect(queryKeys.projects.safetyEvents("p1")).toEqual(["projects", "safety-events", "p1", {}]);
    expect(queryKeys.projects.safetyEvents("p1", { limit: 10 })).toEqual([
      "projects",
      "safety-events",
      "p1",
      { limit: 10 },
    ]);
  });
  it("projects.specKitFiles", () => {
    expect(queryKeys.projects.specKitFiles("p1")).toEqual(["projects", "spec-kit", "p1", "files"]);
  });
  it("projects.specKitEnabled", () => {
    expect(queryKeys.projects.specKitEnabled("p1")).toEqual([
      "projects",
      "spec-kit",
      "p1",
      "enabled",
    ]);
  });
  it("projects.prReviews with and without filters", () => {
    expect(queryKeys.projects.prReviews("p1")).toEqual(["projects", "pr-reviews", "p1", {}]);
    expect(queryKeys.projects.prReviews("p1", { state: "open" })).toEqual([
      "projects",
      "pr-reviews",
      "p1",
      { state: "open" },
    ]);
  });
  it("projects.prReviewDetail", () => {
    expect(queryKeys.projects.prReviewDetail("p1", 42, { owner: "acme", name: "api" })).toEqual([
      "projects",
      "pr-reviews",
      "p1",
      "detail",
      42,
      "acme",
      "api",
    ]);
  });

  // documents
  it("documents.forProject", () => {
    expect(queryKeys.documents.forProject("p1")).toEqual(["documents", "project", "p1"]);
  });

  // analyses
  it("analyses.forProject", () => {
    expect(queryKeys.analyses.forProject("p1")).toEqual(["analyses", "project", "p1"]);
  });
  it("analyses.detail", () => {
    expect(queryKeys.analyses.detail("a1")).toEqual(["analyses", "detail", "a1"]);
  });
  it("analyses.modelPreferences", () => {
    expect(queryKeys.analyses.modelPreferences("p1")).toEqual([
      "analyses",
      "model-preferences",
      "p1",
    ]);
  });
  it("analyses.modelRecommendation with and without override", () => {
    expect(queryKeys.analyses.modelRecommendation("p1")).toEqual([
      "analyses",
      "model-recommendation",
      "p1",
      "auto",
    ]);
    expect(queryKeys.analyses.modelRecommendation("p1", "gpt-4o")).toEqual([
      "analyses",
      "model-recommendation",
      "p1",
      "gpt-4o",
    ]);
  });

  // issues
  it("issues.forProject", () => {
    expect(queryKeys.issues.forProject("p1")).toEqual(["issues", "project", "p1"]);
  });

  // agents
  it("agents.list with and without filters", () => {
    expect(queryKeys.agents.list()).toEqual(["agents", "list", {}]);
    expect(queryKeys.agents.list({ q: "test" })).toEqual(["agents", "list", { q: "test" }]);
  });
  it("agents.detail and versions", () => {
    expect(queryKeys.agents.detail("a1")).toEqual(["agents", "detail", "a1"]);
    expect(queryKeys.agents.versions("a1")).toEqual(["agents", "versions", "a1"]);
  });

  // skills
  it("skills.list with and without filters", () => {
    expect(queryKeys.skills.list()).toEqual(["skills", "list", {}]);
    expect(queryKeys.skills.list({ q: "test" })).toEqual(["skills", "list", { q: "test" }]);
  });
  it("skills.detail and versions", () => {
    expect(queryKeys.skills.detail("s1")).toEqual(["skills", "detail", "s1"]);
    expect(queryKeys.skills.versions("s1")).toEqual(["skills", "versions", "s1"]);
  });

  // library
  it("library.search with and without filters", () => {
    expect(queryKeys.library.search()).toEqual(["library", "search", {}]);
    expect(queryKeys.library.search({ q: "auth" })).toEqual(["library", "search", { q: "auth" }]);
  });
  it("library.projectSkills and projectAgents", () => {
    expect(queryKeys.library.projectSkills("p1")).toEqual(["library", "project", "p1", "skills"]);
    expect(queryKeys.library.projectAgents("p1")).toEqual(["library", "project", "p1", "agents"]);
  });

  // tasks
  it("tasks.list with and without filters", () => {
    expect(queryKeys.tasks.list()).toEqual(["tasks", "list", {}]);
    expect(queryKeys.tasks.list({ status: "running" })).toEqual([
      "tasks",
      "list",
      { status: "running" },
    ]);
  });
  it("tasks.detail", () => {
    expect(queryKeys.tasks.detail("t1")).toEqual(["tasks", "detail", "t1"]);
  });

  // scheduler
  it("scheduler.jobs, job, handlers, history", () => {
    expect(queryKeys.scheduler.jobs()).toEqual(["scheduler", "jobs", {}]);
    expect(queryKeys.scheduler.jobs({ enabled: true })).toEqual([
      "scheduler",
      "jobs",
      { enabled: true },
    ]);
    expect(queryKeys.scheduler.job("j1")).toEqual(["scheduler", "job", "j1"]);
    expect(queryKeys.scheduler.handlers()).toEqual(["scheduler", "handlers"]);
    expect(queryKeys.scheduler.history("j1")).toEqual(["scheduler", "history", "j1"]);
  });

  // admin
  it("admin keys", () => {
    expect(queryKeys.admin.users()).toEqual(["admin", "users"]);
    expect(queryKeys.admin.mcp()).toEqual(["admin", "mcp"]);
    expect(queryKeys.admin.mcpDetail("m1")).toEqual(["admin", "mcp", "m1"]);
    expect(queryKeys.admin.embeddings()).toEqual(["admin", "embeddings"]);
    expect(queryKeys.admin.embeddingsCoverage("p1")).toEqual([
      "admin",
      "embeddings",
      "coverage",
      "p1",
    ]);
  });

  // eval
  it("eval keys with and without optional params", () => {
    expect(queryKeys.eval.leaderboard()).toEqual(["eval", "leaderboard", "all", 30]);
    expect(queryKeys.eval.leaderboard("myBench", 60)).toEqual([
      "eval",
      "leaderboard",
      "myBench",
      60,
    ]);
    expect(queryKeys.eval.run("r1")).toEqual(["eval", "run", "r1"]);
    expect(queryKeys.eval.domainRuns()).toEqual(["eval", "domain", "runs", 90]);
    expect(queryKeys.eval.domainRuns(14)).toEqual(["eval", "domain", "runs", 14]);
    expect(queryKeys.eval.domainRun("dr1")).toEqual(["eval", "domain", "run", "dr1"]);
  });

  // products
  it("products keys with and without optional params", () => {
    expect(queryKeys.products.list()).toEqual(["products", "list", {}]);
    expect(queryKeys.products.list({ q: "x" })).toEqual(["products", "list", { q: "x" }]);
    expect(queryKeys.products.detail("pr1")).toEqual(["products", "detail", "pr1"]);
    expect(queryKeys.products.documents("pr1")).toEqual(["products", "documents", "pr1", "all"]);
    expect(queryKeys.products.documents("pr1", "spec")).toEqual([
      "products",
      "documents",
      "pr1",
      "spec",
    ]);
    expect(queryKeys.products.analyses("pr1")).toEqual(["products", "analyses", "pr1"]);
    expect(queryKeys.products.repoConnections()).toEqual(["products", "repo-connections", ""]);
    expect(queryKeys.products.repoConnections("api")).toEqual([
      "products",
      "repo-connections",
      "api",
    ]);
  });

  // jira
  it("jira keys", () => {
    expect(queryKeys.jira.connections("p1")).toEqual(["jira", "connections", "p1"]);
    expect(queryKeys.jira.connectionDetail("c1")).toEqual(["jira", "connection", "c1"]);
    expect(queryKeys.jira.projects("c1")).toEqual(["jira", "projects", "c1"]);
    expect(queryKeys.jira.search("c1", "project=X")).toEqual([
      "jira",
      "search",
      "c1",
      "project=X",
      0,
    ]);
    expect(queryKeys.jira.search("c1", "project=X", 10)).toEqual([
      "jira",
      "search",
      "c1",
      "project=X",
      10,
    ]);
    expect(queryKeys.jira.issue("c1", "X-1")).toEqual(["jira", "issue", "c1", "X-1"]);
  });

  // imports
  it("imports keys", () => {
    expect(queryKeys.imports.sources("p1")).toEqual(["imports", "sources", "p1"]);
    expect(queryKeys.imports.source("p1", "s1")).toEqual(["imports", "source", "p1", "s1"]);
    expect(queryKeys.imports.runs("p1")).toEqual(["imports", "runs", "p1", "all"]);
    expect(queryKeys.imports.runs("p1", "src1")).toEqual(["imports", "runs", "p1", "src1"]);
  });

  // changeAnalysis
  it("changeAnalysis keys", () => {
    expect(queryKeys.changeAnalysis.forProject("p1")).toEqual(["changeAnalysis", "project", "p1"]);
    expect(queryKeys.changeAnalysis.detail("p1", "ca1")).toEqual([
      "changeAnalysis",
      "detail",
      "p1",
      "ca1",
    ]);
  });

  // publishDestination
  it("publishDestination keys", () => {
    expect(queryKeys.publishDestination.forProject("p1")).toEqual([
      "publishDestination",
      "project",
      "p1",
    ]);
  });
});
