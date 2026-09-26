/**
 * #131 — the record/replay harness carries tool calls: tools key the fixture
 * (only when set, so every older key is unchanged) and a replayed stream emits
 * the recorded calls and finish reason.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureKey } from "./fixture-key.js";
import { FixtureStore } from "./fixture-store.js";
import { RecordingProvider } from "./recording-provider.js";
import { ReplayProvider } from "./replay-provider.js";
import { OfflineStubProvider } from "../providers/offline-stub-provider.js";
import type { ChatChunk, ChatMessage, ChatToolSpec } from "../types.js";

const MSGS: ChatMessage[] = [{ role: "user", content: "find it" }];
const TOOLS: ChatToolSpec[] = [{ name: "x", description: "d", parameters: { type: "object" } }];

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("fixtureKey with tools", () => {
  it("is unchanged when no tools / format are set, and distinct when they are", () => {
    const base = fixtureKey(MSGS, {});
    expect(fixtureKey(MSGS, { tools: [] })).toBe(base);
    expect(fixtureKey(MSGS, { tools: TOOLS })).not.toBe(base);
    expect(fixtureKey(MSGS, { tools: TOOLS, toolChoice: "required" })).not.toBe(
      fixtureKey(MSGS, { tools: TOOLS }),
    );
    expect(fixtureKey(MSGS, { responseFormat: { type: "json_object" } })).not.toBe(base);
  });

  it("keys replayed tool calls and results in the conversation", () => {
    const withCall: ChatMessage[] = [
      ...MSGS,
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "x", args: {} }] },
      { role: "tool", content: "r", toolCallId: "c1", isError: true },
    ];
    const withoutError = withCall.map((m) => ({ ...m, isError: undefined }));
    expect(fixtureKey(withCall)).not.toBe(fixtureKey(withoutError));
  });
});

describe("record → replay round trip", () => {
  it("replays recorded tool calls on chat and as tool_call chunks on stream", async () => {
    dir = mkdtempSync(join(tmpdir(), "metis-fx-tools-"));
    const store = new FixtureStore(dir);
    const inner = new OfflineStubProvider({
      script: [{ toolCalls: [{ id: "c1", name: "x", args: { a: 1 } }] }],
    });
    const recorded = await new RecordingProvider({ inner, store }).chat(MSGS, { tools: TOOLS });
    expect(recorded.toolCalls).toHaveLength(1);

    const replay = new ReplayProvider({ store });
    expect((await replay.chat(MSGS, { tools: TOOLS })).toolCalls).toEqual(recorded.toolCalls);
    const chunks: ChatChunk[] = [];
    for await (const c of replay.stream(MSGS, { tools: TOOLS })) chunks.push(c);
    expect(chunks.filter((c) => c.type === "tool_call")).toEqual([
      { type: "tool_call", name: "x", arguments: { a: 1 }, toolCallId: "c1", native: true },
    ]);
    expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "tool_calls" });
  });
});
