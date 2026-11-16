import { describe, expect, it } from "vitest";
import {
  CODE_EXPLORATION_SETTINGS,
  codeExplorationSettingSchema,
  resolveCodeExploration,
  updateCodeExplorationSchema,
} from "./code-exploration.js";

describe("resolveCodeExploration (#2566)", () => {
  // All six combinations of project setting × platform default.
  const cases = [
    ["auto", "explore", { mode: "explore", reason: "platform-default" }],
    ["auto", "fast", { mode: "fast", reason: "platform-default" }],
    ["explore", "explore", { mode: "explore", reason: "project-explore" }],
    ["explore", "fast", { mode: "explore", reason: "project-explore" }],
    ["fast", "explore", { mode: "fast", reason: "project-fast" }],
    ["fast", "fast", { mode: "fast", reason: "project-fast" }],
  ] as const;
  for (const [setting, platform, expected] of cases) {
    it(`${setting} on a ${platform} platform resolves ${expected.mode} (${expected.reason})`, () => {
      expect(resolveCodeExploration(setting, platform)).toEqual(expected);
    });
  }

  it("treats a missing or unknown stored value as auto", () => {
    for (const raw of [undefined, null, "", "deep", "EXPLORE"]) {
      expect(resolveCodeExploration(raw, "explore")).toEqual({
        mode: "explore",
        reason: "platform-default",
      });
    }
  });
});

describe("the code exploration setting schema (#2566)", () => {
  it("accepts exactly auto, explore and fast", () => {
    expect(CODE_EXPLORATION_SETTINGS).toEqual(["auto", "explore", "fast"]);
    for (const value of CODE_EXPLORATION_SETTINGS) {
      expect(codeExplorationSettingSchema.parse(value)).toBe(value);
    }
    for (const value of ["deep", "", "Explore", 1, null]) {
      expect(codeExplorationSettingSchema.safeParse(value).success).toBe(false);
    }
  });

  it("the PATCH payload takes codeExploration and nothing else", () => {
    expect(updateCodeExplorationSchema.parse({ codeExploration: "fast" })).toEqual({
      codeExploration: "fast",
    });
    expect(updateCodeExplorationSchema.safeParse({}).success).toBe(false);
    expect(
      updateCodeExplorationSchema.safeParse({ codeExploration: "fast", extra: 1 }).success,
    ).toBe(false);
  });
});
