/**
 * #18 — a reply's grounding reaches the chat page two ways: a `grounding` SSE
 * frame while the turn streams, and the `grounding` field of the transcript row
 * read back after it. Both go through the same shared validator.
 */
import { describe, it, expect, vi } from "vitest";
import type { TranscriptMessageDto } from "@metis/shared";

vi.mock("./api-client", () => ({
  streamFetch: vi.fn(),
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { parseSseFrame, transcriptToDisplay } = await import("./ai-client");

const frame = (data: unknown) => `event: grounding\ndata: ${JSON.stringify(data)}`;
const grounded = {
  status: "grounded",
  projectId: "p1",
  projectName: "Payments",
  sources: 3,
} as const;

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

describe("grounding SSE frame (#18)", () => {
  it("parses each status", () => {
    expect(parseSseFrame(frame({ type: "grounding", grounding: grounded }))).toEqual({
      type: "grounding",
      grounding: grounded,
    });
    expect(parseSseFrame(frame({ grounding: { status: "unscoped" } }))).toEqual({
      type: "grounding",
      grounding: { status: "unscoped" },
    });
  });

  it("drops a malformed frame rather than rendering half a label", () => {
    expect(parseSseFrame(frame({ grounding: { status: "grounded", sources: 1 } }))).toBeNull();
    expect(parseSseFrame(frame({}))).toBeNull();
  });
});

describe("transcriptToDisplay grounding (#18)", () => {
  it("carries an assistant row's grounding", () => {
    expect(transcriptToDisplay([row({ grounding: grounded })])[0]!.grounding).toEqual(grounded);
  });

  it("leaves it absent when the row has none (a reply from before #18)", () => {
    expect(transcriptToDisplay([row({})])[0]).not.toHaveProperty("grounding");
    expect(transcriptToDisplay([row({ grounding: null })])[0]).not.toHaveProperty("grounding");
  });

  it("never puts a grounding on a user row", () => {
    const out = transcriptToDisplay([row({ role: "user", grounding: grounded })]);
    expect(out[0]).not.toHaveProperty("grounding");
  });
});
