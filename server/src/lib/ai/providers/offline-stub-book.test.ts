/**
 * #148 — the offline stub's SCRIPT BOOK: scripted conversations selected by a
 * marker in the last user message, turn chosen by how many assistant messages
 * follow it — so one long-running server can drive many multi-turn tool loops
 * (and sub-agent runs) without order-dependent state.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OFFLINE_SCRIPT_FILE_ENV,
  OfflineStubProvider,
  loadOfflineScriptBook,
} from "./offline-stub-provider.js";
import type { ChatChunk } from "../types.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function bookFile(content: string): string {
  dir = mkdtempSync(path.join(os.tmpdir(), "metis-book-"));
  const f = path.join(dir, "book.json");
  writeFileSync(f, content);
  return f;
}

const BOOK = {
  scenarios: [
    {
      match: "MARK-ONE",
      turns: [
        { toolCalls: [{ id: "c1", name: "load_skill", args: { name: "s" } }] },
        { content: "done one" },
      ],
    },
  ],
};

describe("script book", () => {
  it("selects by marker and turn index; unmatched requests get the hash reply", async () => {
    const stub = new OfflineStubProvider({ book: BOOK });
    expect(stub.capabilities.nativeToolCalls).toBe(true);
    const first = await stub.chat([{ role: "user", content: "please MARK-ONE" }]);
    expect(first.toolCalls).toEqual([{ id: "c1", name: "load_skill", args: { name: "s" } }]);
    const second = await stub.chat([
      { role: "user", content: "please MARK-ONE" },
      { role: "assistant", content: "", toolCalls: first.toolCalls },
      { role: "tool", content: "body", toolCallId: "c1" },
    ]);
    expect(second.content).toBe("done one");
    // The same turn again replays the same reply — no hidden cursor.
    expect((await stub.chat([{ role: "user", content: "MARK-ONE" }])).toolCalls).toHaveLength(1);
    const other = await stub.chat([{ role: "user", content: "something else" }]);
    expect(other.content).toContain("[offline-stub]");
    expect(stub.requests).toHaveLength(3);
    // Streamed, the scripted tool call arrives as a native tool_call chunk.
    const chunks: ChatChunk[] = [];
    for await (const c of stub.stream([{ role: "user", content: "MARK-ONE" }])) chunks.push(c);
    expect(chunks.find((c) => c.type === "tool_call")).toMatchObject({
      name: "load_skill",
      native: true,
    });
  });

  it("a turn's system-prompt expectations: a violation replaces the turn with a failure reply", async () => {
    const stub = new OfflineStubProvider({
      book: {
        scenarios: [
          {
            match: "MARK-EXP",
            turns: [
              {
                toolCalls: [{ id: "c1", name: "x", args: {} }],
                expectInSystem: ["CATALOG-LINE"],
                expectNotInSystem: ["SECRET-BODY"],
              },
            ],
          },
        ],
      },
    });
    const ok = await stub.chat([
      { role: "system", content: "CATALOG-LINE" },
      { role: "user", content: "MARK-EXP" },
    ]);
    expect(ok.toolCalls).toHaveLength(1);
    const pasted = await stub.chat([
      { role: "system", content: "CATALOG-LINE SECRET-BODY" },
      { role: "user", content: "MARK-EXP" },
    ]);
    expect(pasted.toolCalls).toBeUndefined();
    expect(pasted.content).toContain("SCRIPT EXPECTATION FAILED");
    const viaOption = await stub.chat([{ role: "user", content: "MARK-EXP" }], {
      systemMessage: "no catalog here",
    });
    expect(viaOption.content).toContain('missing ["CATALOG-LINE"]');
  });

  it("no user message, no match", async () => {
    const stub = new OfflineStubProvider({ book: BOOK });
    const r = await stub.chat([{ role: "system", content: "MARK-ONE" }]);
    expect(r.content).toContain("[offline-stub]");
  });

  it("loads from AI_OFFLINE_SCRIPT_FILE; fromEnv scripts the stub only when it is set", () => {
    const f = bookFile(JSON.stringify(BOOK));
    expect(loadOfflineScriptBook({ [OFFLINE_SCRIPT_FILE_ENV]: f })).toEqual(BOOK);
    expect(
      OfflineStubProvider.fromEnv({ [OFFLINE_SCRIPT_FILE_ENV]: f }).capabilities.nativeToolCalls,
    ).toBe(true);
    expect(OfflineStubProvider.fromEnv({}).capabilities.nativeToolCalls).toBe(false);
    expect(loadOfflineScriptBook({})).toBeUndefined();
  });

  it("an unreadable or malformed book is ignored with a warning — the stub behaves as it always has", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        loadOfflineScriptBook({ [OFFLINE_SCRIPT_FILE_ENV]: "/nonexistent/book.json" }),
      ).toBeUndefined();
      expect(
        loadOfflineScriptBook({ [OFFLINE_SCRIPT_FILE_ENV]: bookFile("{ nope") }),
      ).toBeUndefined();
      expect(
        loadOfflineScriptBook({ [OFFLINE_SCRIPT_FILE_ENV]: bookFile('{"scenarios": {}}') }),
      ).toBeUndefined();
      expect(
        loadOfflineScriptBook({
          [OFFLINE_SCRIPT_FILE_ENV]: bookFile('{"scenarios": [{"match": "ab", "turns": []}]}'),
        }),
      ).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });
});
