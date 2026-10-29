/**
 * Issue #1540 (CodeQL alert 2) — the trailing `satisfies: AC-1 AC-2 …` clause
 * regex in `parseContractTasks` backtracked exponentially: a 113-char line took
 * 471 ms and ~150 chars hung the event loop for minutes. `tasks.md` is LLM
 * output, so its lines are untrusted and unbounded.
 */
import { describe, expect, it } from "vitest";
import { MAX_TASK_LINE_CHARS, parseContractTasks } from "../src/lib/spec-kit/artifact-contract.js";

/** A clause that almost matches — the trailing `!` forces the `$` to fail. */
function adversarialTask(repeats: number): string {
  return `- [ ] Build it satisfies ${"AC-1 ".repeat(repeats)}!`;
}

function timeParse(markdown: string): number {
  const started = performance.now();
  parseContractTasks(markdown);
  return performance.now() - started;
}

describe("parseContractTasks — trailing AC clause (#1540)", () => {
  it("parses a near-miss AC clause in well under 1000 ms", () => {
    // 26 repeats ≈ 150 chars: seconds to minutes under the old pattern.
    expect(timeParse(adversarialTask(26))).toBeLessThan(1000);
  });

  it("parses a very long near-miss line in well under 1000 ms", () => {
    expect(timeParse(adversarialTask(20_000))).toBeLessThan(1000);
  });

  it("parses a long comma-separated near-miss line in well under 1000 ms", () => {
    const line = `- [ ] Build it satisfies: ${"AC-1 , ".repeat(5_000)}!`;
    expect(timeParse(line)).toBeLessThan(1000);
  });

  it("only parses the first MAX_TASK_LINE_CHARS of a line", () => {
    const padding = "x".repeat(MAX_TASK_LINE_CHARS);
    const [task] = parseContractTasks(`- [ ] Build it ${padding} satisfies AC-7`);
    expect(task).toBeDefined();
    expect(task!.acIds).toEqual([]);
    expect(task!.raw.length).toBe(MAX_TASK_LINE_CHARS);
  });

  it.each([
    ["satisfies AC-1", "Build it"],
    ["satisfies: AC-1, AC-2", "Build it"],
    ["satisfies AC-1 AC-2 AC-3", "Build it"],
    ["maps to AC-4,AC-5", "Build it"],
    ["map to: AC-4 , AC-5,", "Build it"],
    ["AC: AC-9", "Build it"],
  ])("still strips the trailing clause %j from the title", (clause, title) => {
    const [task] = parseContractTasks(`- [ ] Build it ${clause}`);
    expect(task!.title).toBe(title);
  });

  it("keeps the title intact when the AC clause is not trailing", () => {
    const [task] = parseContractTasks("- [ ] Build it satisfies AC-1 then ship");
    expect(task!.title).toBe("Build it satisfies AC-1 then ship");
    expect(task!.acIds).toEqual(["AC-1"]);
  });
});
