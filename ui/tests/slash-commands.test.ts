/**
 * Tests for the chat slash-command suggester (Epic #193).
 */
import { describe, expect, it } from "vitest";
import { suggestSlashCommands, parseSpecKitCommand } from "@/components/chat/slash-commands";

describe("suggestSlashCommands", () => {
  it("returns empty for non-slash buffers", () => {
    expect(suggestSlashCommands("")).toEqual([]);
    expect(suggestSlashCommands("hi")).toEqual([]);
  });

  it("returns all six commands for a bare slash", () => {
    expect(suggestSlashCommands("/").map((s) => s.command)).toEqual([
      "specify",
      "plan",
      "tasks",
      "clarify",
      "analyze",
      "implement",
    ]);
  });

  it("filters by prefix case-insensitively", () => {
    expect(suggestSlashCommands("/SP").map((s) => s.command)).toEqual(["specify"]);
    expect(suggestSlashCommands("/cl").map((s) => s.command)).toEqual(["clarify"]);
    expect(suggestSlashCommands("/zzz")).toEqual([]);
  });

  it("includes hint copy", () => {
    const r = suggestSlashCommands("/im");
    expect(r[0]?.hint).toContain("orchestrator");
  });
});

describe("parseSpecKitCommand re-export", () => {
  it("matches the shared parser", () => {
    expect(parseSpecKitCommand("/plan extra")).toEqual({ command: "plan", input: "extra" });
  });
});
