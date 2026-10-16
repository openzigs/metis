/**
 * #1212 — `usage:tick` goes to `project:{id}`, which admits every member of
 * the project's workspace, so it carries no chat `sessionId` (a session is its
 * owner's alone, #142). Everything else in the tick is passed through.
 */
import { describe, expect, it } from "vitest";
import type { MetisIOServer } from "../socket/server.js";
import { createSocketUsageEmitter } from "./socket-emitter.js";

describe("usage:tick emitter", () => {
  it("drops the sessionId and keeps the rest of the tick", () => {
    const sent: Array<[string, string, unknown]> = [];
    const io = {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => void sent.push([room, event, payload]),
      }),
    } as unknown as MetisIOServer;

    createSocketUsageEmitter(io)("p1", {
      projectId: "p1",
      sessionId: "alice-private-session",
      provider: "anthropic",
      model: "m",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costCents: 2,
      ts: 1,
    });

    expect(sent).toEqual([
      [
        "project:p1",
        "usage:tick",
        {
          projectId: "p1",
          provider: "anthropic",
          model: "m",
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          costCents: 2,
          ts: 1,
        },
      ],
    ]);
  });
});
