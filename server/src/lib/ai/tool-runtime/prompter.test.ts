/**
 * #861 — a prompt nobody can answer fails at once instead of waiting out the
 * broker's 120 s timeout. In #706 run 3 a chat over `POST /api/ai/chat` asked
 * for approval of the medium-risk `inspect_schema` under `prompt-once`; no
 * client could answer it, so every such question took ~2 minutes longer and
 * the approval was recorded as `expired`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { approvalRows } = vi.hoisted(() => ({
  approvalRows: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../prisma.js", () => ({
  prisma: {
    aIToolApproval: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        approvalRows.push(data);
        return data;
      }),
      findFirst: vi.fn(async () => null),
    },
  },
}));
vi.mock("../../audit/audit-service.js", () => ({ audit: vi.fn() }));

import { ApprovalGateService } from "../approval-policy.js";
import { OfflineStubProvider } from "../providers/offline-stub-provider.js";
import { DEFAULT_APPROVAL_POLICY } from "../types.js";
import { ToolApprovalBroker } from "./approval-broker.js";
import { runChatToolTurn } from "./chat-turn.js";
import { brokerPrompter } from "./prompter.js";
import { makeToolset } from "./toolset.js";
import type { RuntimeTool, ToolEvent } from "./types.js";

const CTX = { sessionId: "s1", userId: "alice", projectId: "p1" };
const REQ = {
  sessionId: "s1",
  userId: "alice",
  toolName: "inspect_schema",
  risk: "medium" as const,
};

function inspectSchema(): RuntimeTool & { execute: ReturnType<typeof vi.fn> } {
  return {
    name: "inspect_schema",
    wireName: "inspect_schema",
    description: "Read the database schema",
    parameters: { type: "object" },
    risk: "medium",
    source: "metis",
    validate: (args) => ({ ok: true, args }),
    execute: vi.fn(async () => ({ text: "tables: feeds, entries" })),
  };
}

beforeEach(() => {
  approvalRows.length = 0;
});

describe("brokerPrompter — approverPresent (#861)", () => {
  it("answers `unavailable` without registering a pending approval when nobody can answer", async () => {
    const broker = new ToolApprovalBroker();
    const request = vi.spyOn(broker, "request");
    const onEvent = vi.fn();
    const prompter = brokerPrompter({
      broker,
      toolset: makeToolset([inspectSchema()]),
      projectId: "p1",
      approverPresent: async () => false,
      onEvent,
    });
    await expect(prompter.ask({ ...REQ, args: {} })).resolves.toBe("unavailable");
    expect(request).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(broker.size).toBe(0);
  });

  it("asks as before when someone can answer — and when presence cannot be read", async () => {
    for (const approverPresent of [
      async () => true,
      async () => {
        throw new Error("adapter down");
      },
    ]) {
      const broker = new ToolApprovalBroker();
      const events: ToolEvent[] = [];
      const prompter = brokerPrompter({
        broker,
        toolset: makeToolset([inspectSchema()]),
        projectId: "p1",
        approverPresent,
        onEvent: (e) => {
          events.push(e);
          if (e.approvalId) {
            broker.decide({
              approvalId: e.approvalId,
              sessionId: "s1",
              userId: "alice",
              projectId: "p1",
              answer: "approve",
            });
          }
        },
      });
      await expect(prompter.ask({ ...REQ, args: {} })).resolves.toBe("approve");
      expect(events.map((e) => e.phase)).toEqual(["awaiting_approval"]);
    }
  });
});

describe("a non-interactive chat turn with a prompt-once medium tool (#861)", () => {
  it("returns well under the 120 s approval timeout, never runs the tool, and tells the model", async () => {
    const t = inspectSchema();
    const toolset = makeToolset([t]);
    const broker = new ToolApprovalBroker();
    const gate = new ApprovalGateService({
      sessionId: CTX.sessionId,
      userId: CTX.userId,
      // The session default: medium = prompt-once (what `POST /api/ai/sessions` stores).
      policy: DEFAULT_APPROVAL_POLICY,
      // No timeoutMs: the broker's real 120 s default is what used to be waited out.
      prompter: brokerPrompter({
        broker,
        toolset,
        projectId: CTX.projectId,
        approverPresent: async () => false,
      }),
    });
    const provider = new OfflineStubProvider({
      script: [
        { toolCalls: [{ id: "c1", name: "inspect_schema", args: {} }] },
        { content: "Without the schema: feeds are stored per user." },
      ],
    });

    const started = Date.now();
    const out = await runChatToolTurn(provider, {
      messages: [{ role: "user", content: "which tables hold feeds?" }],
      toolset,
      native: true,
      ctx: CTX,
      gate,
    });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(t.execute).not.toHaveBeenCalled();
    expect(out.finalResponse).toBe("Without the schema: feeds are stored per user.");
    expect(out.toolResults[0]).toMatchObject({
      executed: false,
      decision: "deny",
      reason: "no_interactive_approver",
    });
    expect(approvalRows.map((r) => [r.decision, r.reason])).toEqual([
      ["deny", "no_interactive_approver"],
    ]);
    const toolMsg = provider.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(String(toolMsg.content)).toMatch(/no one is available to approve/);
  });
});
