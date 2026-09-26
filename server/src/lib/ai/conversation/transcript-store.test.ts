/**
 * #136 — the transcript store: ordinal races, corrupt rows, DTO shape, and the
 * one-time import of a pre-transcript snapshot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeAiMessageRow } from "../../../../tests/helpers/fake-ai-message.js";

const rows = vi.hoisted(() => [] as FakeAiMessageRow[]);
const delegate = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock("../../prisma.js", async () => {
  const { createFakeAiMessageDelegate } =
    await import("../../../../tests/helpers/fake-ai-message.js");
  delegate.current = createFakeAiMessageDelegate(rows);
  const prisma: Record<string, unknown> = {
    aIMessage: delegate.current,
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return { prisma };
});

const store = await import("./transcript-store.js");
const { importLegacySnapshot } = await import("./legacy-snapshot.js");

beforeEach(() => {
  rows.length = 0;
});

const user = (t: string) => ({
  role: "user" as const,
  parts: [{ type: "text" as const, text: t }],
  estimatedTokens: 1,
});

describe("appendMessage", () => {
  it("assigns 1-based ordinals per session", async () => {
    await store.appendMessage("a", user("1"));
    await store.appendMessage("b", user("x"));
    const second = await store.appendMessage("a", user("2"));
    expect(second.ordinal).toBe(2);
    expect((await store.listMessages("b"))[0]!.ordinal).toBe(1);
  });

  it("two concurrent appends both land, at distinct ordinals", async () => {
    const [x, y] = await Promise.all([
      store.appendMessage("s", user("x")),
      store.appendMessage("s", user("y")),
    ]);
    expect(new Set([x.ordinal, y.ordinal])).toEqual(new Set([1, 2]));
    expect(await store.countMessages("s")).toBe(2);
  });

  it("gives up after repeated ordinal collisions rather than looping", async () => {
    const d = delegate.current as { create: (a: unknown) => Promise<unknown> };
    const spy = vi
      .spyOn(d, "create")
      .mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(store.appendMessage("s", user("x"))).rejects.toMatchObject({ code: "P2002" });
    expect(spy).toHaveBeenCalledTimes(5);
    spy.mockRestore();
  });

  it("rethrows any other error at once", async () => {
    const d = delegate.current as { create: (a: unknown) => Promise<unknown> };
    const spy = vi.spyOn(d, "create").mockRejectedValue(new Error("disk full"));
    await expect(store.appendMessage("s", user("x"))).rejects.toThrow("disk full");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("stores usage, meta and estimates", async () => {
    const m = await store.appendMessage("s", {
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
      estimatedTokens: 2.6,
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: 1 },
      meta: { cached: true },
    });
    expect(m).toMatchObject({
      estimatedTokens: 3,
      inputTokens: 10,
      outputTokens: 2,
      cacheWriteTokens: 1,
      meta: { cached: true },
    });
    expect(rows[0]!.meta).toBe('{"cached":true}');
    await store.appendMessage("s", { ...user("b"), meta: {} });
    expect(rows[1]!.meta).toBeNull();
  });
});

describe("reading rows", () => {
  it("a corrupt content column still renders, as text", () => {
    const m = store.fromRow({
      ...(rows[0] ?? {}),
      id: "x",
      sessionId: "s",
      ordinal: 1,
      role: "user",
      kind: "message",
      content: "{not json",
      estimatedTokens: 0,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      promptChars: null,
      provider: null,
      model: null,
      finishReason: null,
      compactedAt: null,
      compactedIntoId: null,
      meta: "[1]",
      createdAt: new Date(0),
    });
    expect(m.parts).toEqual([{ type: "text", text: "{not json" }]);
    expect(m.meta).toEqual({});
    expect(store.fromRow({ ...m, content: '{"a":1}', meta: "not json" } as never).parts).toEqual(
      [],
    );
  });

  it("listActiveMessages skips compacted rows; getMessageByOrdinal finds one", async () => {
    await store.appendMessage("s", user("1"));
    await store.appendMessage("s", user("2"));
    rows[0]!.compactedAt = new Date();
    expect((await store.listActiveMessages("s")).map((r) => r.ordinal)).toEqual([2]);
    expect((await store.getMessageByOrdinal("s", 1))!.ordinal).toBe(1);
    expect(await store.getMessageByOrdinal("s", 9)).toBeNull();
  });

  it("toDto exposes tokens, summary coverage and an incomplete reply", async () => {
    const m = await store.appendMessage("s", {
      role: "assistant",
      parts: [],
      estimatedTokens: 0,
      meta: { error: { code: "ABORTED" } },
    });
    expect(store.toDto(m)).toMatchObject({
      incomplete: { code: "ABORTED", message: "" },
      summaryOf: null,
      tokens: { input: null },
    });
    const s = await store.appendMessage("s", {
      role: "system",
      kind: "summary",
      parts: [],
      estimatedTokens: 0,
      meta: { fromOrdinal: 1, toOrdinal: 4, messageCount: 4 },
    });
    expect(store.toDto(s).summaryOf).toEqual({ fromOrdinal: 1, toOrdinal: 4, messageCount: 4 });
  });

  it("toDto tells the reader when a summary hit its output cap", async () => {
    const s = await store.appendMessage("s", {
      role: "system",
      kind: "summary",
      parts: [],
      estimatedTokens: 0,
      meta: { fromOrdinal: 1, toOrdinal: 2, messageCount: 2, summaryTruncated: true },
    });
    expect(store.toDto(s).summaryOf).toEqual({
      fromOrdinal: 1,
      toOrdinal: 2,
      messageCount: 2,
      truncated: true,
    });
  });
});

describe("importLegacySnapshot", () => {
  const snap = (messages: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, messages, ...extra });

  it("imports user/assistant text once, tagged, and skips everything else", async () => {
    const n = await importLegacySnapshot(
      "s",
      snap([
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "assistant", content: "" },
        { role: "assistant", content: "a" },
        null,
      ]),
    );
    expect(n).toBe(2);
    const list = await store.listMessages("s");
    expect(list.map((m) => [m.role, m.meta.importedFrom])).toEqual([
      ["user", "legacy-snapshot"],
      ["assistant", "legacy-snapshot"],
    ]);
    expect(await importLegacySnapshot("s", snap([{ role: "user", content: "again" }]))).toBe(0);
  });

  it("two concurrent first imports land the turns exactly once", async () => {
    const s2 = snap([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    const [a, b] = await Promise.all([
      importLegacySnapshot("r", s2),
      importLegacySnapshot("r", s2),
    ]);
    expect(a + b).toBe(2);
    expect((await store.listMessages("r")).map((m) => m.ordinal)).toEqual([1, 2]);
  });

  it("rethrows a failure that is not a lost race", async () => {
    const create = delegate.current!.create as (...a: unknown[]) => unknown;
    delegate.current!.create = async () => {
      throw new Error("disk full");
    };
    try {
      await expect(
        importLegacySnapshot("x", snap([{ role: "user", content: "q" }])),
      ).rejects.toThrow("disk full");
    } finally {
      delegate.current!.create = create;
    }
  });

  it("ignores derived, malformed and empty snapshots", async () => {
    expect(
      await importLegacySnapshot(
        "s",
        snap([{ role: "user", content: "q" }], { derivedFrom: "ai_messages" }),
      ),
    ).toBe(0);
    expect(await importLegacySnapshot("s", "{oops")).toBe(0);
    expect(await importLegacySnapshot("s", snap("nope"))).toBe(0);
    expect(await importLegacySnapshot("s", snap([]))).toBe(0);
    expect(await store.countMessages("s")).toBe(0);
  });
});
