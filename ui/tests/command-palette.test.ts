import { describe, expect, it } from "vitest";
import { fuzzyScore, rankCommands } from "@/components/command-palette/command-palette";

describe("fuzzyScore", () => {
  it("returns 0 for an empty query", () => {
    expect(fuzzyScore("anything", "")).toBe(0);
  });
  it("returns null when characters do not appear in order", () => {
    expect(fuzzyScore("abc", "cab")).toBeNull();
  });
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("Settings page", "stp")).not.toBeNull();
  });
  it("rewards consecutive matches with a lower score", () => {
    const tight = fuzzyScore("dashboard", "dash");
    const loose = fuzzyScore("dashboard", "dbd");
    expect(tight).not.toBeNull();
    expect(loose).not.toBeNull();
    expect(tight!).toBeLessThan(loose!);
  });
});

describe("rankCommands", () => {
  const items = [
    { id: "1", label: "Dashboard", hint: "Page", href: "/dashboard" },
    { id: "2", label: "Workbench", hint: "Page", href: "/workbench" },
    { id: "3", label: "Settings", hint: "Page", href: "/settings" },
    { id: "4", label: "Acme widget redesign", hint: "Project", href: "/projects/acme" },
  ];

  it("returns up to 25 items unchanged when query is empty", () => {
    expect(rankCommands(items, "  ").length).toBe(items.length);
  });
  it("ranks the most-relevant item first", () => {
    const ranked = rankCommands(items, "set");
    expect(ranked[0]?.label).toBe("Settings");
  });
  it("returns empty list when nothing matches", () => {
    expect(rankCommands(items, "zzzqqq")).toEqual([]);
  });
});
