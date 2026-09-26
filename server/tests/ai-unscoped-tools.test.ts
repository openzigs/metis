/**
 * #1368 — an UNSCOPED chat session must not reach METIS's own source tree.
 *
 * The issue's headline symptom was a model shell-grepping `server/src` when the
 * user asked about their own codebase. Making the picker single-select removes
 * the *route* into that state, but it is not the mechanism: METIS's curated code
 * tools were already gated on `projectId`, while the Copilot SDK's BUILT-IN
 * tools (including `bash`) were withheld only when `disableTools` happened to be
 * set — which it was not for any session that had loaded a skill. (The flag is
 * now `withholdSdkBuiltinTools`, read only by the Copilot provider: #142.) So a skill-
 * bearing unscoped session kept `bash` regardless of scope.
 *
 * Falsifiable: against `main`, `buildSdkSkillRuntime` is not exported at all,
 * and the case that matters here — unscoped WITH skills — returned a runtime
 * with no `disableTools` flag.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const materializeSkillsForSession = vi.fn(async () => ({
  skillsDir: "/tmp/skills",
  written: ["skill-a"],
  disabledSkills: [] as string[],
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

vi.mock("../src/lib/library/index.js", () => ({
  getSessionRuntime: () => ({ materializeSkillsForSession }),
  getProjectLibraryAllowlist: () => ({ listSkills: async () => [] }),
  SessionRuntimeError: class extends Error {},
}));

const { buildSdkSkillRuntime } = await import("../src/routes/ai.js");

beforeEach(() => {
  materializeSkillsForSession.mockClear();
});

describe("buildSdkSkillRuntime tool gating (#1368)", () => {
  it("withholds the SDK built-in tools from an unscoped session that has skills", async () => {
    const runtime = await buildSdkSkillRuntime({
      id: "sess_1",
      loadedSkillIds: JSON.stringify(["skill-a"]),
      projectId: null,
    });
    expect(runtime.withholdSdkBuiltinTools).toBe(true);
    // Never `disableTools`: that strips METIS's own tools on every provider.
    expect(runtime).not.toHaveProperty("disableTools");
    // Skills still load — only the tools are withheld.
    expect(runtime.skillDirectories).toEqual(["/tmp/skills"]);
  });

  it("withholds them from a project-scoped session too — its tools go through the gate (#142)", async () => {
    // Epic #128: every chat tool call passes ApprovalGateService. The SDK's
    // built-ins would run under the provider's own permission handler with no
    // gate, so no chat session gets them — scoped or not.
    const runtime = await buildSdkSkillRuntime({
      id: "sess_2",
      loadedSkillIds: JSON.stringify(["skill-a"]),
      projectId: "proj_1",
    });
    expect(runtime.withholdSdkBuiltinTools).toBe(true);
    // Never `disableTools`: that strips METIS's own tools on every provider.
    expect(runtime).not.toHaveProperty("disableTools");
    expect(runtime.skillDirectories).toEqual(["/tmp/skills"]);
  });

  it("still withholds tools from a session with no skills at all", async () => {
    const runtime = await buildSdkSkillRuntime({
      id: "sess_3",
      loadedSkillIds: "[]",
      projectId: "proj_1",
    });
    expect(runtime.withholdSdkBuiltinTools).toBe(true);
    // Never `disableTools`: that strips METIS's own tools on every provider.
    expect(runtime).not.toHaveProperty("disableTools");
  });

  it("withholds tools when skill materialisation fails, rather than failing open", async () => {
    materializeSkillsForSession.mockRejectedValueOnce(new Error("disk full"));
    const runtime = await buildSdkSkillRuntime({
      id: "sess_4",
      loadedSkillIds: JSON.stringify(["skill-a"]),
      projectId: "proj_1",
    });
    expect(runtime.withholdSdkBuiltinTools).toBe(true);
    // Never `disableTools`: that strips METIS's own tools on every provider.
    expect(runtime).not.toHaveProperty("disableTools");
  });

  it("treats a corrupt loadedSkillIds column as no skills", async () => {
    const runtime = await buildSdkSkillRuntime({
      id: "sess_5",
      loadedSkillIds: "not json",
      projectId: null,
    });
    expect(runtime.withholdSdkBuiltinTools).toBe(true);
    // Never `disableTools`: that strips METIS's own tools on every provider.
    expect(runtime).not.toHaveProperty("disableTools");
  });
});
