/**
 * #766 — the in-process registry the analysis page reads to show an agent
 * re-running (and the code agent's tool calls) instead of its stale result.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  beginLiveAgent,
  endLiveAgent,
  markLiveAgentSynthesizing,
  readLiveAgents,
  recordLiveToolCall,
  resetLiveAgentsForTests,
} from "./live-agent-progress.js";

const NOW = new Date("2026-10-21T10:00:00.000Z");

beforeEach(() => resetLiveAgentsForTests());

describe("live agent progress (#766)", () => {
  it("reads nothing for an analysis with no running agent", () => {
    expect(readLiveAgents("an_1")).toEqual([]);
  });

  it("tracks an agent from begin to end", () => {
    expect(beginLiveAgent("an_1", "code", { rerun: true, now: NOW })).toBe(true);
    recordLiveToolCall("an_1", "code");
    recordLiveToolCall("an_1", "code");

    expect(readLiveAgents("an_1")).toEqual([
      {
        agentKey: "code",
        startedAt: NOW.toISOString(),
        toolCalls: 2,
        rerun: true,
        phase: "investigating",
      },
    ]);

    markLiveAgentSynthesizing("an_1", "code");
    expect(readLiveAgents("an_1")[0].phase).toBe("synthesizing");

    endLiveAgent("an_1", "code");
    expect(readLiveAgents("an_1")).toEqual([]);
  });

  it("does not let a nested begin reset the count of the entry that owns it", () => {
    beginLiveAgent("an_1", "code", { rerun: true });
    recordLiveToolCall("an_1", "code");

    // The code agent's own tool loop, inside a Regenerate.
    expect(beginLiveAgent("an_1", "code", { rerun: false })).toBe(false);

    expect(readLiveAgents("an_1")).toEqual([
      expect.objectContaining({ toolCalls: 1, rerun: true }),
    ]);
  });

  it("keeps analyses and agents apart", () => {
    beginLiveAgent("an_1", "code", { rerun: false });
    beginLiveAgent("an_1", "database", { rerun: true });
    beginLiveAgent("an_2", "code", { rerun: false });
    recordLiveToolCall("an_2", "code");

    endLiveAgent("an_1", "database");

    expect(readLiveAgents("an_1").map((a) => [a.agentKey, a.toolCalls])).toEqual([["code", 0]]);
    expect(readLiveAgents("an_2").map((a) => [a.agentKey, a.toolCalls])).toEqual([["code", 1]]);
  });

  it("ignores calls for an agent that is not tracked", () => {
    recordLiveToolCall("an_1", "code");
    markLiveAgentSynthesizing("an_1", "code");
    endLiveAgent("an_1", "code");
    expect(readLiveAgents("an_1")).toEqual([]);
  });

  it("hands out copies, so a reader cannot move the count", () => {
    beginLiveAgent("an_1", "code", { rerun: false });
    readLiveAgents("an_1")[0].toolCalls = 99;
    expect(readLiveAgents("an_1")[0].toolCalls).toBe(0);
  });
});
