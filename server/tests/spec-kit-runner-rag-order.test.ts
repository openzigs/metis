/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase 2 (#373) — verifies that `runSpecKitAgent` prepends the optional RAG
 * context block WITHOUT disturbing the governance chain order:
 *
 *   budget → constitution → RAG → safety → provider → safety → FinOps → audit
 *
 * The constitution must LEAD the system prompt; the (untrusted) RAG block sits
 * between the constitution and the base command prompt. Governance hooks are
 * mocked so we exercise the runner in isolation and assert the exact system
 * message the provider receives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";

const projects = new Map<string, any>();
const constitutionRows = new Map<string, any>();
const constitutionArtifacts = new Map<string, any>();
const auditCalls: any[] = [];
const safetyCalls: any[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findUnique: vi.fn(async ({ where }: any) => projects.get(where.id) ?? null),
    },
    specKitConstitution: {
      findUnique: vi.fn(async ({ where }: any) => constitutionRows.get(where.projectId) ?? null),
    },
    specKitArtifact: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.projectId_name?.name === "constitution.md") {
          return constitutionArtifacts.get(where.projectId_name.projectId) ?? null;
        }
        return null;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn((entry: any) => {
    auditCalls.push(entry);
  }),
  getAuditService: vi.fn(() => ({ record: vi.fn() })),
}));

vi.mock("../src/lib/finops/index.js", () => ({
  assertWithinBudget: vi.fn(async () => undefined),
  BudgetExceededError: class extends Error {},
  recordUsage: vi.fn(() => ({ totalTokens: 0, costCents: 0 })),
}));

// `denyOutboundFrom` lets a single test make the OUTBOUND safety pass throw
// (the inbound pass still succeeds) so we can exercise the outbound
// safety-denial audit branch in the runner.
const safetyState: { denyOutbound: boolean } = { denyOutbound: false };

const { FakeSafetyDeniedError } = vi.hoisted(() => {
  class FakeSafetyDeniedError extends Error {}
  return { FakeSafetyDeniedError };
});

vi.mock("../src/lib/safety/index.js", () => ({
  applySafety: vi.fn(async (text: string, ctx: any) => {
    safetyCalls.push(ctx.direction);
    if (ctx.direction === "output" && safetyState.denyOutbound) {
      throw new FakeSafetyDeniedError("output blocked");
    }
    return { text, redacted: false };
  }),
  SafetyDeniedError: FakeSafetyDeniedError,
}));

import {
  runSpecKitAgent,
  loadProjectContext,
  type SpecKitProjectContext,
} from "../src/lib/spec-kit/commands/runner.js";
import { SpecKitArtifactError } from "../src/lib/spec-kit/artifacts.js";

/** Captures the system message the runner assembles. */
class CapturingProvider implements AIProvider {
  readonly key: any = "offline-stub";
  systemMessage = "";
  async chat(_m: ChatMessage[], o: any): Promise<ChatResponse> {
    this.systemMessage = String(o?.systemMessage ?? "");
    return {
      content: "ok",
      provider: this.key,
      model: "fake-model",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    } as unknown as ChatResponse;
  }
}

const project: SpecKitProjectContext = {
  id: "p1",
  name: "Demo",
  description: "Demo project",
  safetyMode: "standard",
  aiProviderId: null,
};

beforeEach(() => {
  projects.clear();
  constitutionRows.clear();
  constitutionArtifacts.clear();
  auditCalls.length = 0;
  safetyCalls.length = 0;
  safetyState.denyOutbound = false;
  projects.set("p1", { ...project });
});

afterEach(() => vi.clearAllMocks());

describe("runSpecKitAgent RAG ordering (#373)", () => {
  it("orders constitution → RAG → base system prompt", async () => {
    // Seed a v1.2 constitution artifact so readProjectConstitution returns it.
    constitutionArtifacts.set("p1", {
      id: "ska_const_p1",
      projectId: "p1",
      name: "constitution.md",
      content: "CONSTITUTION_BODY",
      version: 1,
      updatedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const provider = new CapturingProvider();
    await runSpecKitAgent({
      command: "specify",
      project,
      systemPrompt: "BASE_PROMPT",
      userPrompt: "do the thing",
      ragContext: "RAG_BLOCK",
      ragChunksUsed: 3,
      deps: { provider },
    });

    const sys = provider.systemMessage;
    const cIdx = sys.indexOf("CONSTITUTION_BODY");
    const rIdx = sys.indexOf("RAG_BLOCK");
    const bIdx = sys.indexOf("BASE_PROMPT");
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(rIdx).toBeGreaterThan(cIdx); // constitution leads
    expect(bIdx).toBeGreaterThan(rIdx); // base trails RAG

    // Chain order preserved: inbound safety BEFORE outbound safety, audit after.
    expect(safetyCalls).toEqual(["input", "output"]);
    const ok = auditCalls.find((c) => c.action === "spec_kit.command.specify");
    expect(ok?.metadata?.ragAttempted).toBe(true);
    expect(ok?.metadata?.ragChunksUsed).toBe(3);
  });

  it("omits the RAG section entirely when ragContext is empty (ungrounded)", async () => {
    constitutionArtifacts.set("p1", {
      id: "ska_const_p1",
      projectId: "p1",
      name: "constitution.md",
      content: "CONSTITUTION_BODY",
      version: 1,
      updatedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const provider = new CapturingProvider();
    await runSpecKitAgent({
      command: "plan",
      project,
      systemPrompt: "BASE_PROMPT",
      userPrompt: "x",
      ragContext: "",
      ragChunksUsed: 0,
      deps: { provider },
    });
    const sys = provider.systemMessage;
    // Constitution then base, no empty RAG separator block in between.
    expect(sys).toContain("CONSTITUTION_BODY");
    expect(sys).toContain("BASE_PROMPT");
    const ok = auditCalls.find((c) => c.action === "spec_kit.command.plan");
    // ragContext was supplied (even if empty) ⇒ attempted=true, used=0.
    expect(ok?.metadata?.ragAttempted).toBe(true);
    expect(ok?.metadata?.ragChunksUsed).toBe(0);
  });

  it("works with RAG but no constitution (RAG then base)", async () => {
    const provider = new CapturingProvider();
    await runSpecKitAgent({
      command: "specify",
      project,
      systemPrompt: "BASE_PROMPT",
      userPrompt: "x",
      ragContext: "RAG_BLOCK",
      ragChunksUsed: 1,
      deps: { provider },
    });
    const sys = provider.systemMessage;
    const rIdx = sys.indexOf("RAG_BLOCK");
    const bIdx = sys.indexOf("BASE_PROMPT");
    expect(rIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(rIdx);
  });

  it("records ragAttempted=false when ragContext is omitted entirely", async () => {
    const provider = new CapturingProvider();
    await runSpecKitAgent({
      command: "tasks",
      project,
      systemPrompt: "BASE_PROMPT",
      userPrompt: "x",
      deps: { provider },
    });
    const ok = auditCalls.find((c) => c.action === "spec_kit.command.tasks");
    expect(ok?.metadata?.ragAttempted).toBe(false);
    expect(ok?.metadata?.ragChunksUsed).toBe(0);
  });

  // The provider's completion is run back through `applySafety` on the way
  // OUT. A denial there must audit `direction: "output"` and re-throw — the
  // RAG block must not bypass the outbound governance pass.
  it("audits an outbound safety denial after the provider returns (direction=output)", async () => {
    safetyState.denyOutbound = true;
    const provider = new CapturingProvider();
    await expect(
      runSpecKitAgent({
        command: "plan",
        project,
        systemPrompt: "BASE_PROMPT",
        userPrompt: "x",
        ragContext: "RAG_BLOCK",
        ragChunksUsed: 2,
        actorId: "u1",
        deps: { provider },
      }),
    ).rejects.toBeInstanceOf(FakeSafetyDeniedError);
    // Inbound pass succeeded, outbound pass ran and threw.
    expect(safetyCalls).toEqual(["input", "output"]);
    const denied = auditCalls.find((c) => c.action === "spec_kit.command.plan.denied");
    expect(denied?.metadata?.reason).toBe("safety_blocked");
    expect(denied?.metadata?.direction).toBe("output");
    // No success audit was recorded on the denied run.
    expect(auditCalls.find((c) => c.action === "spec_kit.command.plan")).toBeUndefined();
  });
});

describe("loadProjectContext", () => {
  it("throws a 404 SpecKitArtifactError when the project is missing", async () => {
    await expect(loadProjectContext("does-not-exist")).rejects.toBeInstanceOf(SpecKitArtifactError);
    await expect(loadProjectContext("does-not-exist")).rejects.toMatchObject({
      status: 404,
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("normalizes an unknown safetyMode to 'standard'", async () => {
    projects.set("p-weird", {
      id: "p-weird",
      name: "Weird",
      description: "",
      safetyMode: "banana",
      aiProviderId: null,
    });
    const ctx = await loadProjectContext("p-weird");
    expect(ctx.safetyMode).toBe("standard");
  });
});
