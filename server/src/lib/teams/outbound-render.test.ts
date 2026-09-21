/**
 * Epic #547 (Phase 2, #550) — outbound Teams message renderer tests.
 */
import { describe, expect, it } from "vitest";

import {
  TEAMS_MESSAGE_MAX_CHARS,
  clampBody,
  renderTeamsMessage,
  renderMirroredMessageActivity,
  PROMOTE_ACTION_ID,
} from "./outbound-render.js";

describe("renderTeamsMessage — human vs AI distinction (#550)", () => {
  it("renders a human message with the bold author name", () => {
    const out = renderTeamsMessage(
      { authorKind: "human", displayName: "Ada Lovelace" },
      "hello team",
    );
    expect(out).toBe("**Ada Lovelace**: hello team");
    expect(out).not.toContain("🤖");
    expect(out).not.toContain("METIS AI");
  });

  it("renders an AI message with the robot marker + model for provenance", () => {
    const out = renderTeamsMessage({ authorKind: "ai", aiModel: "gpt-4o" }, "here is my answer");
    expect(out).toBe("🤖 **METIS AI** (gpt-4o): here is my answer");
    expect(out).toContain("🤖");
  });

  it("omits the model suffix when an AI message has no model", () => {
    const out = renderTeamsMessage({ authorKind: "ai", aiModel: null }, "ok");
    expect(out).toBe("🤖 **METIS AI**: ok");
  });

  it("falls back to a neutral name when a human author has no display name", () => {
    expect(renderTeamsMessage({ authorKind: "human", displayName: null }, "hi")).toBe(
      "**METIS user**: hi",
    );
    expect(renderTeamsMessage({ authorKind: "human", displayName: "   " }, "hi")).toBe(
      "**METIS user**: hi",
    );
  });

  it("treats an unknown author kind as a person, never as AI", () => {
    const out = renderTeamsMessage({ authorKind: "system", displayName: "Bot" }, "x");
    expect(out).toBe("**Bot**: x");
    expect(out).not.toContain("🤖");
  });

  it("clamps an oversized body so the activity never exceeds the Teams limit", () => {
    const big = "a".repeat(TEAMS_MESSAGE_MAX_CHARS + 500);
    const out = renderTeamsMessage({ authorKind: "human", displayName: "X" }, big);
    // The body portion is clamped to the max; the prefix is small + bounded.
    expect(out.length).toBeLessThanOrEqual(TEAMS_MESSAGE_MAX_CHARS + "**X**: ".length);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("clampBody (#550)", () => {
  it("returns short bodies unchanged", () => {
    expect(clampBody("short")).toBe("short");
  });

  it("clamps and ellipsises a body over the max", () => {
    const out = clampBody("abcdef", 4);
    expect(out).toBe("abc…");
    expect(out.length).toBe(4);
  });

  it("returns a body exactly at the max unchanged", () => {
    const exact = "x".repeat(10);
    expect(clampBody(exact, 10)).toBe(exact);
  });
});

describe("renderMirroredMessageActivity — promote-from-Teams card (#553)", () => {
  function findSubmitAction(activity: ReturnType<typeof renderMirroredMessageActivity>): {
    type?: string;
    id?: string;
    title?: string;
    data?: Record<string, unknown>;
  } {
    const card = activity.attachments?.[0]?.content as {
      actions?: Array<{
        type?: string;
        id?: string;
        title?: string;
        data?: Record<string, unknown>;
      }>;
    };
    const action = (card.actions ?? [])[0];
    return action ?? {};
  }

  it("attaches an Adaptive Card with a Promote-to-requirement Action.Submit button carrying the correlation ids", () => {
    const activity = renderMirroredMessageActivity({
      text: "**Ada**: ship the thing",
      threadId: "thread-1",
      messageId: "msg-1",
    });

    expect(activity.attachments).toHaveLength(1);
    expect(activity.attachments?.[0]?.contentType).toBe("application/vnd.microsoft.card.adaptive");

    const action = findSubmitAction(activity);
    // Action.Submit (NOT Action.Execute) — submit arrives back as a `message`
    // activity with `activity.value`, which the functional turn handler already
    // processes. Action.Execute (adaptiveCard/action invoke) is unreliable in
    // botbuilder-js with a non-TeamsActivityHandler turn callback.
    expect(action.type).toBe("Action.Submit");
    expect(action.id).toBe(PROMOTE_ACTION_ID);
    expect(action.title).toMatch(/promote/i);
    // The DiscussionMessage correlation rides in the action data — no schema /
    // correlation table needed; Teams echoes `data` back verbatim on submit.
    expect(action.data).toMatchObject({
      metisAction: "promote",
      threadId: "thread-1",
      messageId: "msg-1",
    });
  });

  it("renders the message text into the card body so the channel still reads naturally", () => {
    const activity = renderMirroredMessageActivity({
      text: "**Ada**: hello",
      threadId: "t",
      messageId: "m",
    });
    const card = activity.attachments?.[0]?.content as {
      body?: Array<{ type?: string; text?: string }>;
    };
    const textBlock = (card.body ?? []).find((b) => b.type === "TextBlock");
    expect(textBlock?.text).toBe("**Ada**: hello");
    // A `text` fallback is set for clients that don't render the card.
    expect(activity.text).toBe("**Ada**: hello");
  });
});
