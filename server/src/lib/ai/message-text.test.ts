/**
 * Unit tests for the messageText() helper (#660 — multimodal ChatMessage).
 */
import { describe, it, expect } from "vitest";
import { messageText } from "./types.js";
import type { ChatContentPart } from "./types.js";

describe("messageText", () => {
  it("returns string content as-is", () => {
    expect(messageText({ content: "hello world" })).toBe("hello world");
  });

  it("returns empty string for empty string content", () => {
    expect(messageText({ content: "" })).toBe("");
  });

  it("extracts text from a single text content block", () => {
    const parts: ChatContentPart[] = [{ type: "text", text: "describe this" }];
    expect(messageText({ content: parts })).toBe("describe this");
  });

  it("concatenates multiple text blocks with newline", () => {
    const parts: ChatContentPart[] = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ];
    expect(messageText({ content: parts })).toBe("first\nsecond");
  });

  it("ignores image_url blocks and returns only text", () => {
    const parts: ChatContentPart[] = [
      { type: "text", text: "describe this image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
    ];
    expect(messageText({ content: parts })).toBe("describe this image");
  });

  it("returns empty string when content array has only image blocks", () => {
    const parts: ChatContentPart[] = [
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ];
    expect(messageText({ content: parts })).toBe("");
  });

  it("returns empty string for empty content array", () => {
    expect(messageText({ content: [] })).toBe("");
  });
});
