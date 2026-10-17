/**
 * #1139 — the `retry` frame: the server is asking the model again after its
 * stream dropped mid-reply, and the client keeps only `keepChars` of the reply.
 */
import { describe, expect, it } from "vitest";
import { parseSseFrame } from "./ai-client";

const frame = (data: unknown) => `event: retry\ndata: ${JSON.stringify(data)}`;

describe("parseSseFrame — retry (#1139)", () => {
  it("reads keepChars and the note", () => {
    expect(parseSseFrame(frame({ type: "retry", keepChars: 12, message: "asking again" }))).toEqual(
      { type: "retry", keepChars: 12, message: "asking again" },
    );
  });

  it("supplies a note when the server sent none", () => {
    expect(parseSseFrame(frame({ keepChars: 0 }))).toEqual({
      type: "retry",
      keepChars: 0,
      message: "The model is being asked again.",
    });
  });

  it.each([[{}], [{ keepChars: -1 }], [{ keepChars: 1.5 }], [{ keepChars: "3" }]])(
    "drops a frame whose keepChars is not a count: %j",
    (data) => {
      expect(parseSseFrame(frame(data))).toBeNull();
    },
  );
});
