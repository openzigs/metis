/**
 * #1573 — a turn whose stream was cut off client-side is still answered on the
 * server. `awaitTurnReply` re-reads the turn until the reply is on record.
 */
import { describe, expect, it, vi } from "vitest";
import { awaitTurnReply, type DisplayTurn, type TranscriptDelta } from "./ai-client";

function delta(rows: Array<Pick<DisplayTurn, "role" | "content">>): TranscriptDelta {
  return {
    afterOrdinal: 0,
    rows: rows.map((r, i) => ({ ...r, ordinal: i + 1, compacted: false })),
    compactionUpdates: [],
  };
}

const question = { role: "user" as const, content: "Which table?" };
const answer = { role: "assistant" as const, content: "orders" };

describe("awaitTurnReply (#1573)", () => {
  it("keeps reading until the reply is on record, then returns that delta", async () => {
    const read = vi
      .fn<() => Promise<TranscriptDelta>>()
      .mockResolvedValueOnce(delta([]))
      .mockResolvedValueOnce(delta([question]))
      .mockResolvedValueOnce(delta([question, answer]));
    const got = await awaitTurnReply(read, { keepGoing: () => true, intervalMs: 1, attempts: 5 });
    expect(read).toHaveBeenCalledTimes(3);
    expect(got?.rows.map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("returns the last read when the reply never arrives", async () => {
    const read = vi.fn(async () => delta([question]));
    const got = await awaitTurnReply(read, { keepGoing: () => true, intervalMs: 1, attempts: 3 });
    expect(read).toHaveBeenCalledTimes(3);
    expect(got?.rows).toHaveLength(1);
  });

  it("tries a failed read again", async () => {
    const read = vi
      .fn<() => Promise<TranscriptDelta>>()
      .mockRejectedValueOnce(new Error("HTTP 502"))
      .mockResolvedValueOnce(delta([question, answer]));
    const got = await awaitTurnReply(read, { keepGoing: () => true, intervalMs: 1, attempts: 3 });
    expect(read).toHaveBeenCalledTimes(2);
    expect(got?.rows).toHaveLength(2);
  });

  it("resolves null when no read succeeded", async () => {
    const read = vi.fn(async (): Promise<TranscriptDelta> => {
      throw new Error("down");
    });
    expect(
      await awaitTurnReply(read, { keepGoing: () => true, intervalMs: 1, attempts: 2 }),
    ).toBeNull();
  });

  it("stops, resolving null, once the reader has moved on", async () => {
    let current = true;
    const read = vi.fn(async () => {
      current = false; // the user opened another session while this read ran
      return delta([question, answer]);
    });
    expect(await awaitTurnReply(read, { keepGoing: () => current, intervalMs: 1 })).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not read at all when the reader has already moved on", async () => {
    const read = vi.fn(async () => delta([question, answer]));
    expect(await awaitTurnReply(read, { keepGoing: () => false })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
