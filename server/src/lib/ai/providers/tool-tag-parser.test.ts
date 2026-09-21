import { describe, it, expect } from "vitest";
import { ToolTagStreamParser, parseToolTags, asChatChunk } from "./tool-tag-parser.js";

/** Feed a sequence of deltas and collect every emitted chunk (push + flush). */
function run(deltas: string[]): ReturnType<ToolTagStreamParser["push"]> {
  const parser = new ToolTagStreamParser();
  const out = [] as ReturnType<ToolTagStreamParser["push"]>;
  for (const d of deltas) out.push(...parser.push(d));
  out.push(...parser.flush());
  return out;
}

/** Concatenate the visible text (delta) portion of the emitted chunks. */
function visibleText(chunks: ReturnType<ToolTagStreamParser["push"]>): string {
  return chunks
    .filter((c) => c.type === "delta")
    .map((c) => (c.type === "delta" ? c.content : ""))
    .join("");
}

describe("ToolTagStreamParser", () => {
  it("passes through plain text unchanged", () => {
    const chunks = run(["Hello, ", "world!"]);
    expect(visibleText(chunks)).toBe("Hello, world!");
    expect(chunks.every((c) => c.type === "delta")).toBe(true);
  });

  it("(a) converts an inline <tool_call> into a structured event and removes it from text", () => {
    const chunks = run([
      'Before <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call> after',
    ]);
    expect(visibleText(chunks)).toBe("Before  after");
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call).toBeDefined();
    if (call?.type === "tool_call") {
      expect(call.name).toBe("bash");
      expect(call.arguments).toEqual({ command: "ls" });
    }
  });

  it("converts <tool_response> into a structured event and strips it from text", () => {
    const chunks = run(['x<tool_response>{"output":"done"}</tool_response>y']);
    expect(visibleText(chunks)).toBe("xy");
    const evt = chunks.find((c) => c.type === "tool_call");
    expect(evt).toBeDefined();
    if (evt?.type === "tool_call") {
      expect(evt.name).toBe("tool_response");
      expect(evt.arguments).toEqual({ output: "done" });
    }
  });

  it("(b split-delta) handles an open tag split across two deltas without leaking a half-tag", () => {
    // "<tool_call>" is split mid-tag between the two deltas.
    const chunks = run([
      "answer <tool_c",
      'all>{"name":"grep","arguments":{"q":"x"}}</tool_call> done',
    ]);
    expect(visibleText(chunks)).toBe("answer  done");
    expect(visibleText(chunks)).not.toContain("<tool_c");
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call?.type === "tool_call" && call.name).toBe("grep");
  });

  it("(b split-delta) handles a closing tag split across deltas", () => {
    const chunks = run(['<tool_call>{"name":"bash","arguments":{}}</tool_', "call>tail"]);
    expect(visibleText(chunks)).toBe("tail");
    expect(visibleText(chunks)).not.toContain("</tool_");
    expect(chunks.some((c) => c.type === "tool_call")).toBe(true);
  });

  it("(b split-delta) handles a tag split character-by-character", () => {
    const payload = '<tool_call>{"name":"echo","arguments":{"v":1}}</tool_call>';
    const chunks = run([...payload].map((ch) => ch));
    expect(visibleText(chunks)).toBe("");
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call?.type === "tool_call" && call.name).toBe("echo");
  });

  it("does NOT mangle legitimate angle brackets in code blocks", () => {
    const text = "```html\n<div><tool>not a tag</div>\n```";
    const chunks = run([text]);
    expect(visibleText(chunks)).toBe(text);
    expect(chunks.some((c) => c.type === "tool_call")).toBe(false);
  });

  it("passes through a trailing partial-looking tag at end of stream as literal text", () => {
    // Stream ends mid-way through what could have been a tag — must not vanish.
    const chunks = run(["result <tool_c"]);
    expect(visibleText(chunks)).toBe("result <tool_c");
  });

  it("drops an unterminated tool block rather than leaking the raw open tag", () => {
    const chunks = run(['prefix <tool_call>{"name":"bash"']);
    expect(visibleText(chunks)).toBe("prefix ");
    expect(visibleText(chunks)).not.toContain("<tool_call>");
  });

  it("handles multiple tool calls in a single delta", () => {
    const chunks = run([
      '<tool_call>{"name":"a","arguments":{}}</tool_call>mid<tool_call>{"name":"b","arguments":{}}</tool_call>',
    ]);
    expect(visibleText(chunks)).toBe("mid");
    const calls = chunks.filter((c) => c.type === "tool_call");
    expect(calls).toHaveLength(2);
  });

  it("emits a best-effort event when the tool body is not valid JSON", () => {
    const chunks = run(["<tool_call>not json here</tool_call>"]);
    expect(visibleText(chunks)).toBe("");
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call).toBeDefined();
    if (call?.type === "tool_call") {
      expect(call.name).toBe("tool");
      expect(call.arguments).toBe("not json here");
    }
  });

  it("keeps a non-JSON <tool_response> body as the raw string argument", () => {
    const chunks = run(["<tool_response>plain output</tool_response>"]);
    expect(visibleText(chunks)).toBe("");
    const evt = chunks.find((c) => c.type === "tool_call");
    if (evt?.type === "tool_call") {
      expect(evt.name).toBe("tool_response");
      expect(evt.arguments).toBe("plain output");
    }
  });

  it("uses the top-level object as arguments when JSON has no `arguments` key", () => {
    const chunks = run(['<tool_call>{"name":"bash","command":"ls"}</tool_call>']);
    const call = chunks.find((c) => c.type === "tool_call");
    if (call?.type === "tool_call") {
      expect(call.name).toBe("bash");
      expect(call.arguments).toEqual({ name: "bash", command: "ls" });
    }
  });

  it("abandons a pathologically large unterminated body without unbounded buffering", () => {
    const parser = new ToolTagStreamParser();
    parser.push("<tool_call>");
    // Push well past the 100k cap without a closing tag.
    for (let i = 0; i < 20; i++) parser.push("x".repeat(10_000));
    const flushed = parser.flush();
    expect(flushed.some((c) => c.type === "delta")).toBe(false);
  });

  it("parseToolTags parses a complete string in one shot", () => {
    const chunks = parseToolTags('hi <tool_call>{"name":"ls","arguments":{}}</tool_call>');
    expect(visibleText(chunks)).toBe("hi ");
    expect(chunks.some((c) => c.type === "tool_call")).toBe(true);
  });

  it("asChatChunk returns the chunk unchanged (type-narrowing helper)", () => {
    const c = { type: "delta", content: "x" } as const;
    expect(asChatChunk(c)).toBe(c);
  });

  it("push ignores empty deltas", () => {
    const parser = new ToolTagStreamParser();
    expect(parser.push("")).toEqual([]);
  });
});
