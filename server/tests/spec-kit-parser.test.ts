/**
 * Unit tests for the Spec Kit slash-command parser (Epic #193).
 * Pure functions — no mocks required.
 */
import { describe, expect, it } from "vitest";
import {
  parseSpecKitCommand,
  isSpecKitCommand,
  isSpecKitArtifactName,
  SPEC_KIT_COMMANDS,
  SPEC_KIT_ARTIFACT_NAMES,
} from "@metis/shared";
import {
  COMMAND_OUTPUT,
  COMMAND_APPENDS,
  parseSpecKitCommand as parseFromServer,
} from "../src/lib/spec-kit/parser.js";

describe("parseSpecKitCommand", () => {
  it("returns null for non-slash input", () => {
    expect(parseSpecKitCommand("hello")).toBeNull();
    expect(parseSpecKitCommand("/model gpt-4o")).toBeNull();
    expect(parseSpecKitCommand("")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(parseSpecKitCommand(null as unknown as string)).toBeNull();
  });

  it("parses each canonical command without arguments", () => {
    for (const cmd of SPEC_KIT_COMMANDS) {
      const r = parseSpecKitCommand(`/${cmd}`);
      expect(r).toEqual({ command: cmd, input: "" });
    }
  });

  it("captures and trims trailing input", () => {
    const r = parseSpecKitCommand("/specify   build a billing dashboard  ");
    expect(r).toEqual({ command: "specify", input: "build a billing dashboard" });
  });

  it("is case-insensitive on the command word", () => {
    expect(parseSpecKitCommand("/SPECIFY foo")).toEqual({ command: "specify", input: "foo" });
  });

  it("supports multi-line input bodies", () => {
    const buf = "/specify line one\nline two\n";
    const r = parseSpecKitCommand(buf);
    expect(r?.command).toBe("specify");
    expect(r?.input).toContain("line two");
  });

  it("re-exports the same parser from the server façade", () => {
    expect(parseFromServer("/plan extra")).toEqual({ command: "plan", input: "extra" });
  });
});

describe("isSpecKitCommand / isSpecKitArtifactName", () => {
  it("recognises the canonical sets only", () => {
    for (const c of SPEC_KIT_COMMANDS) expect(isSpecKitCommand(c)).toBe(true);
    expect(isSpecKitCommand("model")).toBe(false);
    for (const n of SPEC_KIT_ARTIFACT_NAMES) expect(isSpecKitArtifactName(n)).toBe(true);
    expect(isSpecKitArtifactName("foo.md")).toBe(false);
  });
});

describe("COMMAND_OUTPUT / COMMAND_APPENDS", () => {
  it("maps every command to its artifact (or null for /implement)", () => {
    expect(COMMAND_OUTPUT.specify).toBe("spec.md");
    expect(COMMAND_OUTPUT.plan).toBe("plan.md");
    expect(COMMAND_OUTPUT.tasks).toBe("tasks.md");
    expect(COMMAND_OUTPUT.clarify).toBe("clarify.md");
    expect(COMMAND_OUTPUT.analyze).toBe("analysis.md");
    expect(COMMAND_OUTPUT.implement).toBeNull();
  });

  it("flags clarify + analyze as append-only", () => {
    expect(COMMAND_APPENDS.clarify).toBe(true);
    expect(COMMAND_APPENDS.analyze).toBe(true);
    expect(COMMAND_APPENDS.specify).toBe(false);
    expect(COMMAND_APPENDS.plan).toBe(false);
    expect(COMMAND_APPENDS.tasks).toBe(false);
    expect(COMMAND_APPENDS.implement).toBe(false);
  });
});
