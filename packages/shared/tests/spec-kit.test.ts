/**
 * Shared schema/parser coverage for the Spec Kit Mode helpers (Epic #193).
 */
import { describe, expect, it } from "vitest";
import {
  SPEC_KIT_ARTIFACT_NAMES,
  SPEC_KIT_COMMANDS,
  isSpecKitArtifactName,
  isSpecKitCommand,
  parseSpecKitCommand,
  specKitArtifactSchema,
  specKitCommandRequestSchema,
  specKitListResponseSchema,
  specKitWriteRequestSchema,
} from "../src/spec-kit";

describe("Spec Kit constants + guards", () => {
  it("declares the canonical six commands", () => {
    expect([...SPEC_KIT_COMMANDS].sort()).toEqual(
      ["analyze", "clarify", "implement", "plan", "specify", "tasks"].sort(),
    );
  });

  it("declares the six canonical artifact names", () => {
    expect([...SPEC_KIT_ARTIFACT_NAMES].sort()).toEqual(
      ["analysis.md", "clarify.md", "constitution.md", "plan.md", "spec.md", "tasks.md"].sort(),
    );
  });

  it("guards report membership accurately", () => {
    expect(isSpecKitCommand("specify")).toBe(true);
    expect(isSpecKitCommand("model")).toBe(false);
    expect(isSpecKitArtifactName("spec.md")).toBe(true);
    expect(isSpecKitArtifactName("evil")).toBe(false);
  });
});

describe("parseSpecKitCommand", () => {
  it("parses each canonical command", () => {
    for (const c of SPEC_KIT_COMMANDS) {
      expect(parseSpecKitCommand(`/${c}`)).toEqual({ command: c, input: "" });
    }
  });

  it("captures arguments across whitespace and newlines", () => {
    expect(parseSpecKitCommand("/specify   one  ")).toEqual({
      command: "specify",
      input: "one",
    });
    expect(parseSpecKitCommand("/plan a\nb")).toEqual({ command: "plan", input: "a\nb" });
  });

  it("returns null on non-slash buffers", () => {
    expect(parseSpecKitCommand("hello")).toBeNull();
    expect(parseSpecKitCommand("")).toBeNull();
    expect(parseSpecKitCommand("/model gpt")).toBeNull();
  });
});

describe("zod schemas", () => {
  it("specKitArtifactSchema validates a full DTO", () => {
    const dto = {
      id: "ska_1",
      projectId: "p1",
      name: "spec.md",
      content: "body",
      version: 1,
      updatedById: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(() => specKitArtifactSchema.parse(dto)).not.toThrow();
  });

  it("specKitListResponseSchema enforces shape", () => {
    expect(() => specKitListResponseSchema.parse({ enabled: true, artifacts: [] })).not.toThrow();
  });

  it("specKitWriteRequestSchema caps content length", () => {
    expect(() => specKitWriteRequestSchema.parse({ content: "x" })).not.toThrow();
    expect(() => specKitWriteRequestSchema.parse({ content: "x".repeat(200_001) })).toThrow();
  });

  it("specKitCommandRequestSchema defaults input to empty string", () => {
    const r = specKitCommandRequestSchema.parse({});
    expect(r.input).toBe("");
  });
});
