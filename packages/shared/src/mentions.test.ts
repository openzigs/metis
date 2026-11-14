import { describe, expect, it } from "vitest";
import { findMentions } from "./mentions.js";

describe("findMentions (#2220)", () => {
  it("ends a handle before a trailing dot or dash, keeping inner ones", () => {
    expect(findMentions("Thanks @priya.")).toEqual([{ index: 7, handle: "priya" }]);
    expect(findMentions("@john.doe- and @jane_doe")).toEqual([
      { index: 0, handle: "john.doe" },
      { index: 15, handle: "jane_doe" },
    ]);
  });

  it("does not read an email address as a mention", () => {
    expect(findMentions("mail ana@example.com @ now")).toEqual([]);
  });
});
