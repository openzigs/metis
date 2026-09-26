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

// #212 — fork copies in one batched insert; the read pages.
describe("copyTranscriptPrefix (#212)", () => {
  it("copies the prefix in ONE createMany, same ordinals, compaction re-pointed", async () => {
    for (let i = 1; i <= 4; i++) await store.appendMessage("src", user(`m${i}`));
    const d = delegate.current as {
      create: (a: unknown) => Promise<unknown>;
      createMany: (a: unknown) => Promise<unknown>;
    };
    const createSpy = vi.spyOn(d, "create");
    const manySpy = vi.spyOn(d, "createMany");
    try {
      expect(await store.copyTranscriptPrefix("src", "dst", 3)).toBe(3);
      expect(manySpy).toHaveBeenCalledTimes(1);
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
      manySpy.mockRestore();
    }
    const copied = await store.listMessages("dst");
    expect(copied.map((r) => [r.ordinal, partsTextOf(r)])).toEqual([
      [1, "m1"],
      [2, "m2"],
      [3, "m3"],
    ]);
  });

  it("an empty prefix inserts nothing", async () => {
    await store.appendMessage("src", user("m1"));
    expect(await store.copyTranscriptPrefix("src", "dst", 0)).toBe(0);
    expect(await store.countMessages("dst")).toBe(0);
  });

  it("a batch that clashes on (sessionId, ordinal) fails whole and writes nothing", async () => {
    for (let i = 1; i <= 3; i++) await store.appendMessage("src", user(`m${i}`));
    await store.appendMessage("dst", user("already here")); // ordinal 1 taken
    await expect(store.copyTranscriptPrefix("src", "dst", 3)).rejects.toMatchObject({
      code: "P2002",
    });
    expect(await store.countMessages("dst")).toBe(1);
    const d = delegate.current as { createMany: (a: unknown) => Promise<unknown> };
    // Within one batch, too.
    await expect(
      d.createMany({
        data: [
          { sessionId: "x", ordinal: 1, role: "user", content: "[]" },
          { sessionId: "x", ordinal: 1, role: "user", content: "[]" },
        ],
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await store.countMessages("x")).toBe(0);
  });
});

describe("listMessagesPage (#212)", () => {
  it("returns rows after the cursor, at most `limit`, and whether more exist", async () => {
    for (let i = 1; i <= 5; i++) await store.appendMessage("s", user(`m${i}`));
    const p1 = await store.listMessagesPage("s", { afterOrdinal: 0, limit: 2 });
    expect(p1.rows.map((r) => r.ordinal)).toEqual([1, 2]);
    expect(p1).toMatchObject({ hasMore: true, nextAfterOrdinal: 2, compactionUpdates: [] });
    const p3 = await store.listMessagesPage("s", { afterOrdinal: 4, limit: 2 });
    expect(p3.rows.map((r) => r.ordinal)).toEqual([5]);
    expect(p3).toMatchObject({ hasMore: false, nextAfterOrdinal: 5 });
    const none = await store.listMessagesPage("s", { afterOrdinal: 5, limit: 2 });
    expect(none).toMatchObject({ rows: [], hasMore: false, nextAfterOrdinal: 5 });
  });

  it("reports rows at or before the cursor folded by a summary on the page", async () => {
    for (let i = 1; i <= 4; i++) await store.appendMessage("s", user(`m${i}`));
    const summary = await store.appendMessage("s", {
      role: "system",
      kind: "summary",
      parts: [{ type: "text", text: "S" }],
      estimatedTokens: 1,
    });
    const when = new Date("2026-09-01T00:00:00Z");
    for (const r of rows.filter((x) => x.sessionId === "s" && x.ordinal <= 3)) {
      r.compactedAt = when;
      r.compactedIntoId = summary.id;
    }
    const page = await store.listMessagesPage("s", { afterOrdinal: 4, limit: 10 });
    expect(page.rows.map((r) => r.ordinal)).toEqual([5]);
    expect(page.compactionUpdates).toEqual(
      [1, 2, 3].map((ordinal) => ({
        ordinal,
        compactedAt: when,
        compactedIntoId: summary.id,
      })),
    );
    // The summary on a LATER page is not this page's business.
    const early = await store.listMessagesPage("s", { afterOrdinal: 2, limit: 1 });
    expect(early.rows.map((r) => r.ordinal)).toEqual([3]);
    expect(early.compactionUpdates).toEqual([]);
  });
});

function partsTextOf(r: { parts: Array<{ type: string; text?: string }> }): string {
  return r.parts.map((p) => p.text ?? "").join("");
}
