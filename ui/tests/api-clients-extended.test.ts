/**
 * Issue #121 extended — coverage tests for collaboration-api.ts and
 * sdk-alignment-api.ts (both currently at 0% function coverage).
 *
 * Strategy: mock apiFetch and call every exported function once to
 * execute the function bodies and cover all branches in the api wrappers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── collaboration-api ────────────────────────────────────────────────────────

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { apiFetch } from "@/lib/api-client";
import { commentApi, assignmentApi, requirementUpdateApi } from "@/lib/collaboration-api";

const mockFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch.mockReset();
});

describe("commentApi", () => {
  it("listForRequirement extracts data array", async () => {
    const threads = [{ id: "t1", title: null, resolved: false, comments: [] }];
    // apiFetch already unwraps the envelope, so the mock yields the payload directly (#281).
    mockFetch.mockResolvedValueOnce(threads);
    const result = await commentApi.listForRequirement("req-1");
    expect(result).toEqual(threads);
    expect(mockFetch).toHaveBeenCalledWith("/requirements/req-1/comments");
  });

  it("createForRequirement extracts data object", async () => {
    const thread = { id: "t1", title: "Test", resolved: false, comments: [] };
    mockFetch.mockResolvedValueOnce(thread);
    const result = await commentApi.createForRequirement("req-1", { body: "Hello" });
    expect(result).toEqual(thread);
    expect(mockFetch).toHaveBeenCalledWith(
      "/requirements/req-1/comments",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("listForArtifact extracts data array", async () => {
    mockFetch.mockResolvedValueOnce([]);
    const result = await commentApi.listForArtifact("p1", "spec.md");
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledWith("/projects/p1/spec-kit/artifacts/spec.md/comments");
  });

  it("createForArtifact extracts data object", async () => {
    const thread = { id: "t2", title: null, resolved: false, comments: [] };
    mockFetch.mockResolvedValueOnce(thread);
    const result = await commentApi.createForArtifact("p1", "spec.md", { body: "note" });
    expect(result).toEqual(thread);
  });

  it("reply extracts data object", async () => {
    const comment = { id: "c1", body: "reply text", deleted: false };
    mockFetch.mockResolvedValueOnce(comment);
    const result = await commentApi.reply("t1", "reply text");
    expect(result).toEqual(comment);
    expect(mockFetch).toHaveBeenCalledWith(
      "/comments/t1/replies",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("edit extracts data object", async () => {
    const comment = { id: "c1", body: "edited", deleted: false };
    mockFetch.mockResolvedValueOnce(comment);
    const result = await commentApi.edit("c1", "edited");
    expect(result).toEqual(comment);
  });

  it("delete calls apiFetch with DELETE", async () => {
    mockFetch.mockResolvedValueOnce(undefined);
    await commentApi.delete("c1");
    expect(mockFetch).toHaveBeenCalledWith("/comments/c1", { method: "DELETE" });
  });
});

describe("assignmentApi", () => {
  it("list extracts data array", async () => {
    mockFetch.mockResolvedValueOnce([]);
    const result = await assignmentApi.list("req-1");
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledWith("/requirements/req-1/assignments");
  });

  it("assign extracts data object", async () => {
    const assignment = { id: "a1", assigneeId: "u1", slaDeadline: null };
    mockFetch.mockResolvedValueOnce(assignment);
    const result = await assignmentApi.assign("req-1", { assigneeId: "u1" });
    expect(result).toEqual(assignment);
  });

  it("unassign calls apiFetch with DELETE", async () => {
    mockFetch.mockResolvedValueOnce(undefined);
    await assignmentApi.unassign("req-1", "u1");
    expect(mockFetch).toHaveBeenCalledWith("/requirements/req-1/assignments/u1", {
      method: "DELETE",
    });
  });
});

describe("requirementUpdateApi", () => {
  it("update extracts data object", async () => {
    const updated = { id: "req-1", version: 2, updatedAt: "2026-01-01T00:00:00Z" };
    mockFetch.mockResolvedValueOnce(updated);
    const result = await requirementUpdateApi.update("req-1", { title: "Updated" });
    expect(result).toEqual(updated);
  });
});

// ─── sdk-alignment-api ────────────────────────────────────────────────────────

import { sdkApi } from "@/lib/sdk-alignment-api";

describe("sdkApi — agents", () => {
  it("listAgents calls correct endpoint", async () => {
    mockFetch.mockResolvedValueOnce([]);
    await sdkApi.listAgents();
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/custom-agents"));
    const [calledPath] = mockFetch.mock.calls[0] as [string];
    expect(calledPath.startsWith("/api/")).toBe(false);
  });

  it("listAgents with projectId and no builtIns", async () => {
    mockFetch.mockResolvedValueOnce([]);
    await sdkApi.listAgents("p1", false);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("projectId=p1"));
  });

  it("getAgent calls correct endpoint", async () => {
    mockFetch.mockResolvedValueOnce({ id: "a1" });
    const result = await sdkApi.getAgent("a1");
    expect(mockFetch).toHaveBeenCalledWith("/custom-agents/a1");
    expect(result).toEqual({ id: "a1" });
  });

  it("createAgent calls POST", async () => {
    mockFetch.mockResolvedValueOnce({ id: "a2" });
    await sdkApi.createAgent({ projectId: "p1", name: "Agent", systemPrompt: "You are..." });
    expect(mockFetch).toHaveBeenCalledWith(
      "/custom-agents",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("updateAgent calls PATCH", async () => {
    mockFetch.mockResolvedValueOnce({ id: "a1" });
    await sdkApi.updateAgent("a1", { name: "Updated" });
    expect(mockFetch).toHaveBeenCalledWith(
      "/custom-agents/a1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("deleteAgent calls DELETE", async () => {
    mockFetch.mockResolvedValueOnce(undefined);
    await sdkApi.deleteAgent("a1");
    expect(mockFetch).toHaveBeenCalledWith(
      "/custom-agents/a1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("sdkApi — hooks", () => {
  it("listHooks calls correct endpoint", async () => {
    mockFetch.mockResolvedValueOnce([]);
    await sdkApi.listHooks("p1");
    expect(mockFetch).toHaveBeenCalledWith("/projects/p1/hooks");
  });

  it("createHook calls POST", async () => {
    mockFetch.mockResolvedValueOnce({ id: "h1" });
    await sdkApi.createHook("p1", {
      event: "analysis.completed" as never,
      handlerKind: "webhook",
      config: { url: "https://example.com" },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "/projects/p1/hooks",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("deleteHook calls DELETE", async () => {
    mockFetch.mockResolvedValueOnce(undefined);
    await sdkApi.deleteHook("p1", "h1");
    expect(mockFetch).toHaveBeenCalledWith(
      "/projects/p1/hooks/h1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("sdkApi — hooks (extended)", () => {
  it("updateHook calls PATCH", async () => {
    mockFetch.mockResolvedValueOnce({ id: "h1" });
    await sdkApi.updateHook("p1", "h1", { enabled: false });
    expect(mockFetch).toHaveBeenCalledWith(
      "/projects/p1/hooks/h1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});

describe("sdkApi — skill dirs", () => {
  it("getSkillDirs calls correct endpoint", async () => {
    mockFetch.mockResolvedValueOnce([]);
    await sdkApi.getSkillDirs("p1");
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/projects/p1"));
    const [skillDirsPath] = mockFetch.mock.calls[0] as [string];
    expect(skillDirsPath.startsWith("/api/")).toBe(false);
  });

  it("addSkillDir calls POST", async () => {
    mockFetch.mockResolvedValueOnce({ dirs: [".github/skills"] });
    await sdkApi.addSkillDir("p1", ".github/skills");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("removeSkillDir calls DELETE", async () => {
    mockFetch.mockResolvedValueOnce({ dirs: [] });
    await sdkApi.removeSkillDir("p1", ".github/skills");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("getDisabledSkills calls correct endpoint", async () => {
    mockFetch.mockResolvedValueOnce({ disabled: [] });
    await sdkApi.getDisabledSkills("p1");
    expect(mockFetch).toHaveBeenCalledWith("/projects/p1/disabled-skills");
  });

  it("disableSkill calls POST", async () => {
    mockFetch.mockResolvedValueOnce({ disabled: ["some-skill"] });
    await sdkApi.disableSkill("p1", "some-skill");
    expect(mockFetch).toHaveBeenCalledWith(
      "/projects/p1/disabled-skills",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("enableSkill calls DELETE", async () => {
    mockFetch.mockResolvedValueOnce({ disabled: [] });
    await sdkApi.enableSkill("p1", "some-skill");
    expect(mockFetch).toHaveBeenCalledWith(
      "/projects/p1/disabled-skills",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("sdkApi — sessions and plans", () => {
  it("listResumable calls correct endpoint", async () => {
    mockFetch.mockResolvedValueOnce([]);
    await sdkApi.listResumable();
    expect(mockFetch).toHaveBeenCalledWith("/ai/sessions?status=resumable");
  });

  it("resumeSession calls POST", async () => {
    mockFetch.mockResolvedValueOnce({});
    await sdkApi.resumeSession("s1");
    expect(mockFetch).toHaveBeenCalledWith(
      "/ai/sessions/s1/resume",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("switchModel calls PATCH", async () => {
    mockFetch.mockResolvedValueOnce({ currentModel: "claude-3", previousModel: null });
    await sdkApi.switchModel("s1", { model: "claude-3" });
    expect(mockFetch).toHaveBeenCalledWith(
      "/ai/sessions/s1/model",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("getPlan calls correct endpoint", async () => {
    mockFetch.mockResolvedValueOnce(null);
    await sdkApi.getPlan("s1");
    expect(mockFetch).toHaveBeenCalledWith("/ai/sessions/s1/plan");
  });

  it("recordPlan calls POST", async () => {
    mockFetch.mockResolvedValueOnce({ sessionId: "s1" });
    await sdkApi.recordPlan("s1", "1. Analyze\n2. Implement");
    expect(mockFetch).toHaveBeenCalledWith(
      "/ai/sessions/s1/plan",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("decidePlan calls POST with decision", async () => {
    mockFetch.mockResolvedValueOnce({ sessionId: "s1", decision: "approved" });
    await sdkApi.decidePlan("s1", "approved");
    expect(mockFetch).toHaveBeenCalledWith(
      "/ai/sessions/s1/approve-plan",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
