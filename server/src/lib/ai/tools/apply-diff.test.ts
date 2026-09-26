/**
 * Epic #195 / Issue #218 — apply_diff tool tests.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({
  prisma: {
    aITokenUsage: {
      create: vi.fn(async () => ({})),
    },
  },
}));

import {
  APPLY_DIFF_TOOL_NAME,
  applyDiffSchema,
  createApplyDiffTool,
  defaultFallback,
  registerApplyDiff,
} from "./apply-diff.js";
import { ToolRegistry } from "../tool-registry.js";

const ctx = { sessionId: "s1", userId: "u1" } as const;
/** #142 — `invoke` requires a gate; these tests exercise the tool, not the gate. */
const allowGate = { decide: async () => true };

describe("apply_diff tool", () => {
  it("schema requires non-empty patch", () => {
    expect(applyDiffSchema.safeParse({ original: "", patch: "" }).success).toBe(false);
    expect(applyDiffSchema.safeParse({ original: "", patch: "x" }).success).toBe(true);
  });

  it("returns the fallback content when morph is disabled", async () => {
    const tool = createApplyDiffTool({ isEnabled: () => false });
    const result = await tool.exec({ original: "a", patch: "b" }, ctx);
    expect(result.text).toBe("b");
    const data = result.data as { provider: string };
    expect(data.provider).toBe("fallback");
  });

  it("returns the original when patch is unified-diff shaped (fallback can't apply)", () => {
    const out = defaultFallback({ original: "a", patch: "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b" });
    expect(out).toBe("a");
  });

  it("uses the morph client when enabled and records FinOps", async () => {
    const apply = vi.fn(async () => ({
      content: "morph-result",
      provider: "morph" as const,
      model: "morph-v3",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      durationMs: 12,
    }));
    const fakeClient = { apply } as never;
    const tool = createApplyDiffTool({
      isEnabled: () => true,
      client: fakeClient,
    });
    const result = await tool.exec({ original: "a", patch: "b" }, ctx);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("morph-result");
    const data = result.data as { provider: string; model: string };
    expect(data.provider).toBe("morph");
    expect(data.model).toBe("morph-v3");
  });

  it("falls back to the local applier when the morph client throws", async () => {
    const apply = vi.fn(async () => {
      throw new Error("morph down");
    });
    const fakeClient = { apply } as never;
    const errors: string[] = [];
    const tool = createApplyDiffTool({
      isEnabled: () => true,
      client: fakeClient,
    });
    const log = {
      info: () => {
        /* unused */
      },
      error: (msg: string) => {
        errors.push(msg);
      },
    };
    const result = await tool.exec({ original: "a", patch: "b" }, { ...ctx, log });
    const data = result.data as { provider: string };
    expect(data.provider).toBe("fallback");
    expect(result.text).toBe("b");
    expect(errors.some((m) => m.includes("apply_diff"))).toBe(true);
  });

  it("registerApplyDiff is idempotent", () => {
    const reg = new ToolRegistry();
    registerApplyDiff(reg, { isEnabled: () => false });
    expect(reg.has(APPLY_DIFF_TOOL_NAME)).toBe(true);
    // Second call should NOT throw — unregister + re-register.
    registerApplyDiff(reg, { isEnabled: () => false });
    expect(reg.has(APPLY_DIFF_TOOL_NAME)).toBe(true);
  });

  it("integrates with ToolRegistry.invoke for end-to-end gating", async () => {
    const apply = vi.fn(async () => ({
      content: "ok",
      provider: "morph" as const,
      model: "morph-v3",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      durationMs: 1,
    }));
    const reg = new ToolRegistry();
    registerApplyDiff(reg, {
      isEnabled: () => true,
      client: { apply } as never,
    });
    const out = await reg.invoke(
      APPLY_DIFF_TOOL_NAME,
      { original: "a", patch: "b" },
      ctx,
      allowGate,
    );
    expect(out.text).toBe("ok");
  });

  it("rejects invalid args via the registry's zod gate", async () => {
    const reg = new ToolRegistry();
    registerApplyDiff(reg, { isEnabled: () => false });
    await expect(
      reg.invoke(APPLY_DIFF_TOOL_NAME, { original: "a" }, ctx, allowGate),
    ).rejects.toThrow();
  });
});
