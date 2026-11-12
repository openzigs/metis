/**
 * #2242 — a reply's checked citations reach the chat page as a `citations` SSE
 * frame before `done`, and as the `citations` field of the transcript row read
 * back after it. Both go through the shared validator.
 */
import { describe, it, expect, vi } from "vitest";
import type { TranscriptMessageDto } from "@metis/shared";

vi.mock("./api-client", () => ({
  streamFetch: vi.fn(),
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { parseSseFrame, transcriptToDisplay } = await import("./ai-client");

const frame = (data: unknown) => `event: citations\ndata: ${JSON.stringify(data)}`;
const cited = [
  { text: "src/a.ts:3", path: "src/a.ts", lines: [3, 3], status: "verified", source: "repo" },
  { text: "src/b.ts", path: "src/b.ts", status: "not-read" },
];

function row(over: Partial<TranscriptMessageDto>): TranscriptMessageDto {
  return {
    id: "m",
    ordinal: 1,
    role: "assistant",
    kind: "message",
    parts: [{ type: "text", text: "hi" }],
    tokens: { estimated: 1, input: null, output: null, cacheRead: null, cacheWrite: null },
    provider: null,
    model: null,
    finishReason: null,
    compactedAt: null,
    compactedIntoId: null,
    summaryOf: null,
    incomplete: null,
    createdAt: "",
    ...over,
  };
}

describe("citations SSE frame (#2242)", () => {
  it("parses the checked citations", () => {
    expect(parseSseFrame(frame({ type: "citations", citations: cited }))).toEqual({
      type: "citations",
      citations: cited,
    });
  });

  it("drops a frame with nothing well-formed in it", () => {
    expect(parseSseFrame(frame({ citations: [{ text: "a" }] }))).toBeNull();
    expect(parseSseFrame(frame({}))).toBeNull();
  });
});

describe("transcriptToDisplay citations (#2242)", () => {
  it("carries an assistant row's citations", () => {
    expect(
      transcriptToDisplay([row({ citations: cited as TranscriptMessageDto["citations"] })])[0]!
        .citations,
    ).toEqual(cited);
  });

  it("leaves them absent when the row has none, and never puts them on a user row", () => {
    expect(transcriptToDisplay([row({})])[0]).not.toHaveProperty("citations");
    const user = transcriptToDisplay([
      row({ role: "user", citations: cited as TranscriptMessageDto["citations"] }),
    ]);
    expect(user[0]).not.toHaveProperty("citations");
  });
});
