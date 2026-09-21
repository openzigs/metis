import { describe, it, expect } from "vitest";
import { stripToolTags } from "@/lib/strip-tool-tags";

describe("stripToolTags (#718)", () => {
  it("returns plain text unchanged", () => {
    expect(stripToolTags("hello world")).toBe("hello world");
  });

  it("removes a complete <tool_call> pair and its contents", () => {
    expect(stripToolTags('a <tool_call>{"name":"bash","arguments":{}}</tool_call> b')).toBe("a  b");
  });

  it("removes a complete <tool_response> pair and its contents", () => {
    expect(stripToolTags('x<tool_response>{"output":"ok"}</tool_response>y')).toBe("xy");
  });

  it("removes multiple tool tags in one string", () => {
    expect(stripToolTags("<tool_call>a</tool_call>mid<tool_response>b</tool_response>end")).toBe(
      "midend",
    );
  });

  it("removes an orphaned opening tag without a close", () => {
    expect(stripToolTags("prefix <tool_call>{oops")).toBe("prefix {oops");
  });

  it("removes an orphaned closing tag", () => {
    expect(stripToolTags("stray </tool_call> tag")).toBe("stray  tag");
  });

  it("does NOT mangle legitimate angle brackets or code blocks", () => {
    const code = "```html\n<div><span>hi</span></div>\n```";
    expect(stripToolTags(code)).toBe(code);
    expect(stripToolTags("Array<T> and <html>")).toBe("Array<T> and <html>");
  });

  it("handles empty input", () => {
    expect(stripToolTags("")).toBe("");
  });
});
