import { describe, expect, it } from "vitest";
import { fixtureKey, keyedOptions } from "./fixture-key.js";
import type { ChatMessage } from "../types.js";

const msgs = (text: string): ChatMessage[] => [{ role: "user", content: text }];

describe("fixtureKey", () => {
  it("is deterministic for identical requests", () => {
    expect(fixtureKey(msgs("hi"))).toBe(fixtureKey(msgs("hi")));
  });

  it("differs when message content differs", () => {
    expect(fixtureKey(msgs("hi"))).not.toBe(fixtureKey(msgs("bye")));
  });

  it("differs when a response-affecting option differs", () => {
    expect(fixtureKey(msgs("hi"), { model: "a" })).not.toBe(fixtureKey(msgs("hi"), { model: "b" }));
  });

  it("ignores volatile options like signal and skillDirectories", () => {
    const a = fixtureKey(msgs("hi"), {
      model: "m",
      signal: new AbortController().signal,
      skillDirectories: ["/tmp/x"],
      disabledSkills: ["y"],
    });
    const b = fixtureKey(msgs("hi"), { model: "m" });
    expect(a).toBe(b);
  });

  it("treats omitted and explicit-undefined options the same", () => {
    expect(fixtureKey(msgs("hi"), {})).toBe(fixtureKey(msgs("hi"), { model: undefined }));
  });

  it("distinguishes multimodal content from plain text", () => {
    const multimodal: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    expect(fixtureKey(multimodal)).not.toBe(fixtureKey(msgs("hi")));
  });

  it("includes message name/toolCallId in the key", () => {
    const a: ChatMessage[] = [{ role: "tool", content: "r", name: "search", toolCallId: "1" }];
    const b: ChatMessage[] = [{ role: "tool", content: "r", name: "fetch", toolCallId: "1" }];
    expect(fixtureKey(a)).not.toBe(fixtureKey(b));
  });

  it("produces a hex sha256 (64 chars)", () => {
    expect(fixtureKey(msgs("hi"))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("keyedOptions", () => {
  it("strips undefined and volatile fields", () => {
    const out = keyedOptions({
      model: "m",
      temperature: 0.5,
      seed: 7,
      signal: new AbortController().signal,
      sessionId: "ignored",
    });
    expect(out).toEqual({ model: "m", temperature: 0.5, seed: 7 });
  });

  it("returns empty object for empty options", () => {
    expect(keyedOptions()).toEqual({});
  });

  it("retains all keyed sampling fields", () => {
    const out = keyedOptions({
      systemMessage: "s",
      reasoningEffort: "high",
      disableThinking: true,
      disableTools: true,
      maxTokens: 100,
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
    });
    expect(out).toEqual({
      systemMessage: "s",
      reasoningEffort: "high",
      disableThinking: true,
      disableTools: true,
      maxTokens: 100,
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
    });
  });
});
