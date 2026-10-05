/**
 * #853 — the Spec Kit prompts must not leak the walkthrough's expected answer.
 *
 * The /plan EXISTING CAPABILITY CHECK used `MarkAllAsReadBeforeDate` beside
 * `MarkAllAsRead` as its worked example — exactly the function the #706
 * walkthrough expects a plan to find in Miniflux. A plan that then "found" it
 * could have copied it from the prompt, so the #785 check measured nothing.
 * These are names from the walkthrough's ground-truth repo (Miniflux v2.3.3);
 * no prompt text the model reads may name any of them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLAN_SYSTEM_PROMPT, SPECIFY_SYSTEM_PROMPT } from "./prompts.js";
import { TASKS_SYSTEM_PROMPT } from "./tasks.js";

const WALKTHROUGH_GROUND_TRUTH = [
  "MarkAllAsReadBeforeDate",
  "MarkAllAsRead",
  "MarkFeedAsRead",
  "MarkCategoryAsRead",
  "SetEntriesStatus",
  "ScheduleNextCheck",
  "UpdateFeed",
  "RefreshFeed",
  "CreateFeed",
  "ArchiveEntries",
];

function named(text: string): string[] {
  return WALKTHROUGH_GROUND_TRUTH.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
}

describe("Spec Kit prompts name no walkthrough ground-truth symbol (#853)", () => {
  it.each([
    ["PLAN_SYSTEM_PROMPT", PLAN_SYSTEM_PROMPT],
    ["SPECIFY_SYSTEM_PROMPT", SPECIFY_SYSTEM_PROMPT],
    ["TASKS_SYSTEM_PROMPT", TASKS_SYSTEM_PROMPT],
  ])("%s", (_label, prompt) => {
    expect(named(prompt)).toEqual([]);
  });

  it("no command module (every prompt string, exported or not) names one", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .flatMap((f) => named(readFileSync(join(dir, f), "utf8")).map((n) => `${f}: ${n}`));
    expect(offenders).toEqual([]);
  });

  it("keeps a worked sibling example, just a neutral one", () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/`\w+` next to `\w+`/);
  });

  it("asks for the symbol's real line span and forbids a chunk number", () => {
    expect(PLAN_SYSTEM_PROMPT).toContain("Existing capability: <name> at <path:startLine-endLine>");
    expect(PLAN_SYSTEM_PROMPT).toMatch(/chunk number, never a line/);
  });
});
