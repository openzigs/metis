/**
 * #789 — the Spec Kit palette offers and dispatches the `speckit.*` commands,
 * never the deprecated legacy aliases.
 */
import { describe, expect, it } from "vitest";
import { SPECKIT_COMMANDS } from "@metis/shared";
import {
  FEATURE_REQUIRED_COMMANDS,
  parsePaletteCommand,
  suggestPaletteCommands,
} from "@/lib/spec-kit-palette";

describe("suggestPaletteCommands", () => {
  it("is empty for a buffer that is not a slash command", () => {
    expect(suggestPaletteCommands("")).toEqual([]);
    expect(suggestPaletteCommands("plan")).toEqual([]);
  });

  it("offers every speckit.* command for a bare slash, each with a hint", () => {
    const all = suggestPaletteCommands("/");
    expect(all.map((s) => s.command)).toEqual([...SPECKIT_COMMANDS]);
    expect(all.every((s) => s.hint.length > 0)).toBe(true);
  });

  it("matches the namespaced form, so typing /speckit suggests", () => {
    expect(suggestPaletteCommands("/speckit").length).toBe(SPECKIT_COMMANDS.length);
    expect(suggestPaletteCommands("/SpecKit.Ch").map((s) => s.command)).toEqual([
      "speckit.checklist",
    ]);
  });

  it("matches the short name too, but suggests the namespaced command", () => {
    expect(suggestPaletteCommands("/pl").map((s) => s.command)).toEqual(["speckit.plan"]);
    expect(suggestPaletteCommands("/tasks").map((s) => s.command)).toEqual([
      "speckit.tasks",
      "speckit.taskstoissues",
    ]);
    expect(suggestPaletteCommands("/zzz")).toEqual([]);
  });

  it("stops suggesting once the command word is followed by input", () => {
    expect(suggestPaletteCommands("/speckit.plan go")).toEqual([]);
  });
});

describe("parsePaletteCommand", () => {
  it("parses a namespaced command and its input", () => {
    expect(parsePaletteCommand("/speckit.checklist  security ")).toEqual({
      command: "speckit.checklist",
      input: "security",
    });
    expect(parsePaletteCommand("/speckit.constitution")).toEqual({
      command: "speckit.constitution",
      input: "",
    });
  });

  it("maps a typed legacy alias to its speckit.* successor", () => {
    expect(parsePaletteCommand("/specify build a dashboard")).toEqual({
      command: "speckit.specify",
      input: "build a dashboard",
    });
  });

  it("keeps multi-line input", () => {
    expect(parsePaletteCommand("/speckit.constitution # A\n\nB")?.input).toBe("# A\n\nB");
  });

  it("returns null for anything else", () => {
    expect(parsePaletteCommand("hello")).toBeNull();
    expect(parsePaletteCommand("/model gpt")).toBeNull();
    expect(parsePaletteCommand("/")).toBeNull();
  });
});

describe("FEATURE_REQUIRED_COMMANDS", () => {
  it("lists the commands the server refuses without a featureSlug", () => {
    expect([...FEATURE_REQUIRED_COMMANDS].sort()).toEqual([
      "speckit.checklist",
      "speckit.plan",
      "speckit.taskstoissues",
    ]);
  });
});
