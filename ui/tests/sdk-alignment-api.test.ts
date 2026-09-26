/**
 * Regression guard for the `/api/api/...` double-prefix bug.
 *
 * `apiFetch` (see src/lib/api-client.ts) already prepends `API_BASE = "/api"`
 * (src/lib/config.ts) to every path. The SDK-alignment client must therefore
 * pass UNPREFIXED paths (e.g. `/custom-agents`, not `/api/custom-agents`),
 * otherwise every request resolves to `/api/api/...` and 404s across the
 * sessions / custom-agents / hooks / skills UI surfaces.
 *
 * This test is data-driven: it invokes EVERY public method on `sdkApi` with
 * minimal dummy arguments, captures the path handed to `apiFetch`, and asserts
 * the path is absolute (`/...`) but is NOT prefixed with `/api`. Adding a new
 * method to `sdkApi` is automatically covered — the test iterates the live
 * object's keys, so a new double-prefixed path fails this guard immediately.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockApiFetch = vi.fn();

vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  streamFetch: vi.fn(),
}));

const { sdkApi } = await import("../src/lib/sdk-alignment-api");

/**
 * Minimal dummy invocation for every public `sdkApi` method. Arguments are
 * supplied positionally; values are placeholders — only the path passed to
 * `apiFetch` is under test, never the response.
 */
const invocations: Record<keyof typeof sdkApi, () => unknown> = {
  // Agents
  listAgents: () => sdkApi.listAgents("p1", true),
  getAgent: () => sdkApi.getAgent("a1"),
  listTools: () => sdkApi.listTools(),
  createAgent: () => sdkApi.createAgent({ projectId: "p1", name: "n", systemPrompt: "s" }),
  updateAgent: () => sdkApi.updateAgent("a1", { name: "n2" }),
  deleteAgent: () => sdkApi.deleteAgent("a1"),
  invokeAgent: () => sdkApi.invokeAgent("a1", { projectId: "p1", input: "hi" }),
  // Enablement
  listEnabledAgents: () => sdkApi.listEnabledAgents("p1"),
  setAgentEnablement: () => sdkApi.setAgentEnablement("a1", { projectId: "p1", enabled: true }),
  // Hooks
  listHooks: () => sdkApi.listHooks("p1"),
  createHook: () => sdkApi.createHook("p1", { event: "preToolUse" }),
  updateHook: () => sdkApi.updateHook("p1", "h1", { enabled: false }),
  deleteHook: () => sdkApi.deleteHook("p1", "h1"),
  // Skill directories
  getSkillDirs: () => sdkApi.getSkillDirs("p1"),
  addSkillDir: () => sdkApi.addSkillDir("p1", "/some/dir"),
  removeSkillDir: () => sdkApi.removeSkillDir("p1", "/some/dir"),
  getDisabledSkills: () => sdkApi.getDisabledSkills("p1"),
  disableSkill: () => sdkApi.disableSkill("p1", "slug"),
  enableSkill: () => sdkApi.enableSkill("p1", "slug"),
  // Sessions / plan / model
  listResumable: () => sdkApi.listResumable(),
  resumeSession: () => sdkApi.resumeSession("s1"),
  switchModel: () => sdkApi.switchModel("s1", { model: "m" }),
  getPlan: () => sdkApi.getPlan("s1"),
  recordPlan: () => sdkApi.recordPlan("s1", "plan text"),
  decidePlan: () => sdkApi.decidePlan("s1", "approved"),
};

describe("sdkApi path prefixing (regression: no /api/api double-prefix)", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue(undefined);
  });

  it("exposes an invocation for every public sdkApi method", () => {
    // If a new method is added to sdkApi but not to `invocations`, this fails,
    // forcing the new method into the data-driven path assertions below.
    const declared = Object.keys(sdkApi).sort();
    const covered = Object.keys(invocations).sort();
    expect(covered).toEqual(declared);
  });

  const methodNames = Object.keys(invocations) as (keyof typeof sdkApi)[];

  it.each(methodNames)("%s passes an unprefixed absolute path to apiFetch", (method) => {
    invocations[method]();

    expect(mockApiFetch).toHaveBeenCalled();
    const [path] = mockApiFetch.mock.calls[0] as [string];

    expect(typeof path).toBe("string");
    // Absolute (apiFetch's buildUrl normalizes, but every path here is rooted).
    expect(path.startsWith("/")).toBe(true);
    // The bug: a leading `/api` would become `/api/api/...` after buildUrl.
    expect(path).not.toBe("/api");
    expect(path.startsWith("/api/")).toBe(false);
    expect(path.startsWith("/api?")).toBe(false);
  });
});
