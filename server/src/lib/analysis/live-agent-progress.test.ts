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
  setLiveAgentContinuation,
  setLiveAgentMode,
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
        filesRead: 0,
        searches: 0,
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

  it("#1131 — records a continuation's scope, and copies it out", () => {
    setLiveAgentContinuation("an_1", "code", { requirements: 3, total: 19 });
    expect(readLiveAgents("an_1")).toEqual([]);
    beginLiveAgent("an_1", "code", { rerun: true });
    setLiveAgentContinuation("an_1", "code", { requirements: 3, total: 19 });
    readLiveAgents("an_1")[0].continuation!.requirements = 99;
    expect(readLiveAgents("an_1")[0].continuation).toEqual({ requirements: 3, total: 19 });
  });
});

describe("live explore progress (#2570)", () => {
  const grep = (text: string) => ({ tool: "grep_files", args: { text } });
  const read = (filePath: string) => ({ tool: "read_file_slice", args: { filePath } });

  it("counts searches and files read by tool name: 2 greps, 3 reads, 1 graph search", () => {
    beginLiveAgent("an_1", "code", { rerun: false });
    recordLiveToolCall("an_1", "code", grep("fee"));
    recordLiveToolCall("an_1", "code", read("src/a.ts"));
    recordLiveToolCall("an_1", "code", grep("total"));
    recordLiveToolCall("an_1", "code", read("src/b.ts"));
    recordLiveToolCall("an_1", "code", { tool: "search_code_graph", args: { query: "fee" } });
    recordLiveToolCall("an_1", "code", read("src/c.ts"));
    expect(readLiveAgents("an_1")[0]).toMatchObject({ toolCalls: 6, filesRead: 3, searches: 3 });
  });

  it("counts distinct files: 3 reads of 2 files is 2, however the path is spelled", () => {
    beginLiveAgent("an_1", "code", { rerun: false });
    recordLiveToolCall("an_1", "code", read("src/a.ts"));
    recordLiveToolCall("an_1", "code", read("./src/a.ts"));
    recordLiveToolCall("an_1", "code", read("src/b.ts"));
    expect(readLiveAgents("an_1")[0]).toMatchObject({ toolCalls: 3, filesRead: 2 });
  });

  it("one path in two repositories is two files", () => {
    beginLiveAgent("an_1", "code", { rerun: false });
    recordLiveToolCall("an_1", "code", { ...read("src/a.ts"), repo: "rc_1" });
    recordLiveToolCall("an_1", "code", { ...read("src/a.ts"), repo: "rc_2" });
    expect(readLiveAgents("an_1")[0]?.filesRead).toBe(2);
  });

  it("an errored call is a step, but neither a search nor a file read", () => {
    beginLiveAgent("an_1", "code", { rerun: false });
    recordLiveToolCall("an_1", "code", { ...read("src/gone.ts"), isError: true });
    recordLiveToolCall("an_1", "code", { ...grep("fee"), isError: true });
    recordLiveToolCall("an_1", "code", { tool: "read_file_slice", args: {} });
    recordLiveToolCall("an_1", "code", { tool: "list_files", args: { pattern: "*" } });
    recordLiveToolCall("an_1", "code", { tool: "search_code_symbols", args: { query: "fee" } });
    expect(readLiveAgents("an_1")[0]).toMatchObject({ toolCalls: 5, filesRead: 0, searches: 1 });
  });

  it("serves counts only: no path and no argument of any call", () => {
    beginLiveAgent("an_1", "code", { rerun: false });
    recordLiveToolCall("an_1", "code", read("secret/zz-marker-path-7f3a.ts"));
    recordLiveToolCall("an_1", "code", grep("zz-marker-term-9q"));
    const served = JSON.stringify(readLiveAgents("an_1"));
    expect(served).not.toContain("zz-marker");
    expect(served).not.toContain("secret");
  });

  it("records the mode: explore only while every pass explored", () => {
    setLiveAgentMode("an_1", "code", "explore");
    expect(readLiveAgents("an_1")).toEqual([]);
    beginLiveAgent("an_1", "code", { rerun: false });
    expect(readLiveAgents("an_1")[0]).not.toHaveProperty("mode");
    setLiveAgentMode("an_1", "code", "explore");
    expect(readLiveAgents("an_1")[0]?.mode).toBe("explore");
    setLiveAgentMode("an_1", "code", "fast");
    setLiveAgentMode("an_1", "code", "explore");
    expect(readLiveAgents("an_1")[0]?.mode).toBe("fast");
  });

  it("a begin after an end starts the files read from zero", () => {
    beginLiveAgent("an_1", "code", { rerun: false });
    recordLiveToolCall("an_1", "code", read("src/a.ts"));
    endLiveAgent("an_1", "code");
    beginLiveAgent("an_1", "code", { rerun: true });
    recordLiveToolCall("an_1", "code", read("src/a.ts"));
    expect(readLiveAgents("an_1")[0]?.filesRead).toBe(1);
  });
});
