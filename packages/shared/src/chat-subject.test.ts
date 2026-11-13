import { describe, expect, it } from "vitest";
import { CHAT_SUBJECT_ID_MAX, chatSubjectParam, parseChatSubjectParam } from "./chat-subject.js";

describe("chat subject param (#2350)", () => {
  it("round-trips each kind", () => {
    for (const kind of ["project", "change-request", "requirement"] as const) {
      expect(parseChatSubjectParam(chatSubjectParam(kind, "c123"))).toEqual({ kind, id: "c123" });
    }
  });

  it("encodes an id so it stays one value, and decodes it back", () => {
    const raw = chatSubjectParam("requirement", "a/b?c&d");
    expect(raw).toBe("requirement:a%2Fb%3Fc%26d");
    expect(parseChatSubjectParam(raw)).toEqual({ kind: "requirement", id: "a/b?c&d" });
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["project"],
    [":abc"],
    ["project:"],
    ["workspace:abc"],
    ["PROJECT:abc"],
    ["project:%E0%A4%A"],
    [`project:${"x".repeat(CHAT_SUBJECT_ID_MAX + 1)}`],
  ])("refuses %s", (raw) => {
    expect(parseChatSubjectParam(raw)).toBeNull();
  });

  it("accepts an id of exactly the maximum length", () => {
    const id = "x".repeat(CHAT_SUBJECT_ID_MAX);
    expect(parseChatSubjectParam(`project:${id}`)).toEqual({ kind: "project", id });
  });
});
