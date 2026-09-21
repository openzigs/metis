import { describe, it, expect, vi, beforeEach } from "vitest";
import { skillsApi, agentsApi, libraryApi } from "@/lib/library-api";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn().mockResolvedValue({ items: [] }),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from "@/lib/api-client";
const mockApi = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mockApi.mockClear());

describe("skillsApi wrapper", () => {
  it("forwards filters as query params", async () => {
    await skillsApi.list({ q: "yaml", tag: "core" });
    expect(mockApi).toHaveBeenCalledWith("/skills", { params: { q: "yaml", tag: "core" } });
  });
  it("posts source on create", async () => {
    await skillsApi.create("---\nname: x\n---\n", "x", "inline");
    expect(mockApi).toHaveBeenCalledWith("/skills", {
      method: "POST",
      body: { source: "---\nname: x\n---\n", key: "x", origin: "inline" },
    });
  });
  it("PATCHes source on update without optional fields", async () => {
    await skillsApi.update("id-1", "src");
    expect(mockApi).toHaveBeenCalledWith("/skills/id-1", {
      method: "PATCH",
      body: { source: "src" },
    });
  });
  it("calls archive/enable/disable endpoints", async () => {
    await skillsApi.archive("id-1");
    expect(mockApi).toHaveBeenCalledWith("/skills/id-1/archive", { method: "POST" });
    await skillsApi.enable("id-1");
    expect(mockApi).toHaveBeenCalledWith("/skills/id-1/enable", { method: "POST" });
    await skillsApi.disable("id-1");
    expect(mockApi).toHaveBeenCalledWith("/skills/id-1/disable", { method: "POST" });
  });
  it("DELETEs on remove", async () => {
    await skillsApi.remove("id-1");
    expect(mockApi).toHaveBeenCalledWith("/skills/id-1", { method: "DELETE" });
  });
});

describe("agentsApi wrapper", () => {
  it("posts defaultSkillKeys on create", async () => {
    await agentsApi.create("src", ["k1", "k2"]);
    expect(mockApi).toHaveBeenCalledWith("/agents", {
      method: "POST",
      body: { source: "src", defaultSkillKeys: ["k1", "k2"] },
    });
  });
  it("omits defaultSkillKeys when undefined on update", async () => {
    await agentsApi.update("id-1", "src");
    expect(mockApi).toHaveBeenCalledWith("/agents/id-1", {
      method: "PATCH",
      body: { source: "src" },
    });
  });
});

describe("libraryApi wrapper", () => {
  it("toggles a project skill via PUT", async () => {
    await libraryApi.setProjectSkill("p1", "s1", true);
    expect(mockApi).toHaveBeenCalledWith("/projects/p1/library/skills/s1", {
      method: "PUT",
      body: { enabled: true },
    });
  });
  it("toggles a project agent via PUT", async () => {
    await libraryApi.setProjectAgent("p1", "a1", false);
    expect(mockApi).toHaveBeenCalledWith("/projects/p1/library/agents/a1", {
      method: "PUT",
      body: { enabled: false },
    });
  });
  it("forwards search filters", async () => {
    await libraryApi.search({ q: "x", kind: "agent" });
    expect(mockApi).toHaveBeenCalledWith("/library", { params: { q: "x", kind: "agent" } });
  });
  it("fetches per-project skill and agent allowlists", async () => {
    await libraryApi.projectSkills("p1");
    expect(mockApi).toHaveBeenCalledWith("/projects/p1/library/skills");
    await libraryApi.projectAgents("p1");
    expect(mockApi).toHaveBeenCalledWith("/projects/p1/library/agents");
  });
  it("removes per-project skill and agent allowlist entries", async () => {
    await libraryApi.removeProjectSkill("p1", "s1");
    expect(mockApi).toHaveBeenCalledWith("/projects/p1/library/skills/s1", { method: "DELETE" });
    await libraryApi.removeProjectAgent("p1", "a1");
    expect(mockApi).toHaveBeenCalledWith("/projects/p1/library/agents/a1", { method: "DELETE" });
  });
});

describe("skillsApi additional wrappers", () => {
  it("GETs a single skill by id", async () => {
    await skillsApi.get("id-1");
    expect(mockApi).toHaveBeenCalledWith("/skills/id-1");
  });
  it("forwards an empty filter set", async () => {
    await skillsApi.list();
    expect(mockApi).toHaveBeenCalledWith("/skills", { params: undefined });
  });
  it("lists versions for a skill", async () => {
    await skillsApi.versions("id-1");
    expect(mockApi).toHaveBeenCalledWith("/skills/id-1/versions");
  });
});

describe("agentsApi additional wrappers", () => {
  it("GETs a single agent by id", async () => {
    await agentsApi.get("ag-1");
    expect(mockApi).toHaveBeenCalledWith("/agents/ag-1");
  });
  it("calls archive/enable/disable on an agent", async () => {
    await agentsApi.archive("ag-1");
    expect(mockApi).toHaveBeenCalledWith("/agents/ag-1/archive", { method: "POST" });
    await agentsApi.enable("ag-1");
    expect(mockApi).toHaveBeenCalledWith("/agents/ag-1/enable", { method: "POST" });
    await agentsApi.disable("ag-1");
    expect(mockApi).toHaveBeenCalledWith("/agents/ag-1/disable", { method: "POST" });
  });
  it("DELETEs on remove and lists versions", async () => {
    await agentsApi.remove("ag-1");
    expect(mockApi).toHaveBeenCalledWith("/agents/ag-1", { method: "DELETE" });
    await agentsApi.versions("ag-1");
    expect(mockApi).toHaveBeenCalledWith("/agents/ag-1/versions");
  });
  it("includes defaultSkillKeys on update when supplied, plus optional key", async () => {
    await agentsApi.update("ag-1", "src", ["k1"], "kx");
    expect(mockApi).toHaveBeenCalledWith("/agents/ag-1", {
      method: "PATCH",
      body: { source: "src", defaultSkillKeys: ["k1"], key: "kx" },
    });
  });
  it("forwards list filters", async () => {
    await agentsApi.list({ q: "rese", includeArchived: "1" });
    expect(mockApi).toHaveBeenCalledWith("/agents", {
      params: { q: "rese", includeArchived: "1" },
    });
  });
});
