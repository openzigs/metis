/** #143 — the live tool-activity list: idempotent, forward-only, fixed error text. */
import { describe, it, expect } from "vitest";
import type { AiToolEvent } from "@metis/shared";
import { applyToolEvent, decisionLabel, toolErrorText } from "./tool-activity";

const ev = (over: Partial<AiToolEvent>): AiToolEvent => ({
  type: "tool_event",
  phase: "started",
  sessionId: "s1",
  callId: "c1",
  name: "t",
  risk: "high",
  source: "metis",
  ts: 1,
  ...over,
});

describe("applyToolEvent", () => {
  it("upserts by call id and keeps earlier fields", () => {
    let list = applyToolEvent([], ev({ argsPreview: '{"a":1}' }));
    list = applyToolEvent(list, ev({ phase: "awaiting_approval", approvalId: "apr_1" }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      phase: "awaiting_approval",
      approvalId: "apr_1",
      argsPreview: '{"a":1}',
    });
  });

  it("never moves a call backwards (SSE and socket both deliver)", () => {
    let list = applyToolEvent([], ev({ phase: "result", resultPreview: "ok" }));
    list = applyToolEvent(list, ev({ phase: "awaiting_approval", approvalId: "apr_1" }));
    list = applyToolEvent(list, ev({ phase: "started" }));
    expect(list[0]!.phase).toBe("result");
    expect(list[0]!.approvalId).toBeUndefined();
  });

  it("keeps calls in arrival order", () => {
    const list = applyToolEvent(applyToolEvent([], ev({ callId: "a" })), ev({ callId: "b" }));
    expect(list.map((a) => a.callId)).toEqual(["a", "b"]);
  });
});

describe("fixed text", () => {
  it("maps every code, and anything else to a generic line", () => {
    expect(toolErrorText("TOOL_DENIED")).toMatch(/Denied/);
    expect(toolErrorText(undefined)).toBe("The tool call failed.");
    expect(toolErrorText("SOMETHING_ELSE" as never)).toBe("The tool call failed.");
  });

  it("labels recorded decisions", () => {
    expect(decisionLabel("approve", true)).toBe("approved by you");
    expect(decisionLabel("auto-approve", true)).toBe("allowed by policy");
    expect(decisionLabel("deny", false)).toBe("denied");
    expect(decisionLabel("expired", false)).toBe("not answered in time");
    expect(decisionLabel(undefined, false)).toBe("not run");
    expect(decisionLabel(undefined, true)).toBe("ran");
  });
});
